// The transport: one request, its retries, its timeout, and the mapping of every
// failure onto the two error classes. Bare `fetch`, no runtime dependencies.
//
// Retry policy: 5xx, network failures and 429 are retried with exponential backoff
// and `Retry-After` honored; every other 4xx is terminal, because re-sending
// something the server already refused only spends the caller's time twice.

import type { ResolvedConfig } from "./config.ts"
import { TelemError, TimeoutError } from "./errors.ts"

/** Any JSON object off the wire. `any` on purpose: this is untrusted, arbitrarily
 *  shaped server data, and each builder narrows what it actually reads. */
export type Payload = Record<string, any>

/** The ceiling on any single wait, however long the server asks for. */
const MAX_DELAY_MS = 30_000
/** The longest timer a runtime accepts; a longer finite timeout is clamped to it. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** The first backoff; every retry after it doubles, up to the ceiling. */
const BASE_DELAY_MS = 500

export function isObject(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read an object off untrusted JSON; anything else reads as empty. */
export function asObject(value: unknown): Payload {
  return isObject(value) ? value : {}
}

/** Read an array off untrusted JSON; anything else reads as empty. */
export function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

/** An argument rejected before anything was sent, so there is no status. */
export function invalidRequest(message: string): TelemError {
  return new TelemError(message, { code: "invalid_request" })
}

/** Validate a caller's list of strings — queries, URLs — before anything is sent. */
export function stringList(items: unknown, empty: string, what: string): string[] {
  const list = asArray(items)
  if (!list.length) throw invalidRequest(empty)
  for (const item of list) {
    if (typeof item !== "string") {
      throw invalidRequest(`${what} must be strings, got ${item === null ? "null" : typeof item}`)
    }
    if (item === "") throw invalidRequest(`${what} must not be empty`)
  }
  return list
}

/** The `{code, message}` object an error body carries, if any: `error` on
 *  `/v1/fetch`, or an object-shaped `detail` on `/v1/interactions` (typed refusals
 *  such as a 409). */
function errorEnvelope(body: unknown): Payload | undefined {
  if (!isObject(body)) return undefined
  if (isObject(body.error)) return body.error
  if (isObject(body.detail)) return body.detail
  return undefined
}

/**
 * Extract a human-readable message from a parsed error body.
 *
 * The envelope's `message` surfaces here and its stable `code` is read separately,
 * because codes are the contract and messages are not. A FastAPI `detail` may also
 * be a string, or (validation errors) a list whose items' `msg` values join with
 * ", " so the error reads as a message rather than a dumped object.
 */
function detailFromBody(body: unknown): string | undefined {
  if (!isObject(body)) return undefined
  const envelope = errorEnvelope(body)
  if (envelope && typeof envelope.message === "string" && envelope.message) {
    return envelope.message
  }
  const detail = body.detail
  if (typeof detail === "string" && detail) return detail
  if (Array.isArray(detail) && detail.length) {
    const messages = detail
      .map((item) => (isObject(item) && typeof item.msg === "string" ? item.msg : undefined))
      .filter((message): message is string => message !== undefined)
    // A pydantic error whose items carry only `loc` still has to read as something.
    return messages.join(", ") || JSON.stringify(detail)
  }
  return undefined
}

/** The stable code an error envelope carried, if any. Never invented: a server
 *  failure the envelope does not name leaves `code` undefined. */
function codeFromBody(body: unknown): string | undefined {
  const envelope = errorEnvelope(body)
  return envelope && typeof envelope.code === "string" ? envelope.code : undefined
}

/** What a transport must hand back for the client to read it. */
function isResponseLike(value: unknown): value is Response {
  return (
    isObject(value) &&
    typeof value.text === "function" &&
    typeof value.status === "number" &&
    typeof value.headers?.get === "function"
  )
}

/** The transport returned something that is not a Response: the embedder's bug, not
 *  the network's, so it is never retried. */
class NotAResponse extends Error {}

function defaultMessage(status: number): string {
  if (status === 400) return "Bad request"
  if (status === 401 || status === 403) return "Authentication failed"
  if (status === 404) return "Not found"
  return `Unexpected status code ${status}`
}

function statusError(status: number, body: unknown): TelemError {
  return new TelemError(detailFromBody(body) ?? defaultMessage(status), {
    status,
    code: codeFromBody(body),
    details: body,
  })
}

/** Wrap a transport failure — no HTTP response was ever produced. A real `fetch`
 *  throws `TypeError: fetch failed` with the socket error one level down on `.cause`,
 *  which is where the useful text lives; an injected transport may throw anything. */
function connectionError(url: string, cause: unknown): TelemError {
  const error = cause as { message?: unknown; cause?: { message?: unknown } } | undefined
  const detail =
    (typeof error?.cause?.message === "string" && error.cause.message) ||
    (typeof error?.message === "string" && error.message) ||
    String(cause)
  return new TelemError(`could not reach ${url}: ${detail}`, {
    code: "connection_error",
    cause,
  })
}

/** 5xx is transient, and 429 is the one 4xx that says to come back. */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429
}

function backoff(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
}

/**
 * How long to wait before the next attempt.
 *
 * Only the delta-seconds form of `Retry-After` is parsed. RFC 9110 also allows an
 * HTTP-date, but reading one means trusting the client's clock against the server's,
 * and a skewed clock turns into a multi-hour sleep or none at all — so a date, like
 * any other unparseable value, falls back to the backoff. Every wait is capped: honor
 * the signal, bound the block.
 */
function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null && /^\s*\d+\s*$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, MAX_DELAY_MS)
  }
  return backoff(attempt)
}

/**
 * Send one request, retrying per the rules above, and return the parsed body.
 *
 * @param config - The client's resolved configuration.
 * @param method - `GET` or `POST`.
 * @param path - Request path, joined onto the resolved base URL.
 * @param body - JSON request body; omitted entirely for a GET.
 * @returns The parsed JSON body, or the raw text when it would not parse.
 * @throws TimeoutError when the request was still outstanding at the timeout.
 * @throws TelemError on any non-2xx response or transport failure.
 */
export async function request(
  config: ResolvedConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  /** The caller's abort signal: aborts the attempt, skips the retry, rejects with its reason. */
  abort?: AbortSignal,
): Promise<unknown> {
  const url = `${config.baseUrl}/${path.replace(/^\/+/, "")}`
  const headers: Record<string, string> = { "User-Agent": config.userAgent }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    try {
      init.body = JSON.stringify(body)
    } catch (cause) {
      // Caller data the wire cannot carry (a cycle, a BigInt) — rejected here, as
      // an invalid request, rather than escaping as a bare TypeError.
      throw invalidRequest(`request body is not JSON: ${(cause as Error)?.message ?? String(cause)}`)
    }
  }

  // The caller's abort, as a rejection the backoff sleeps race against: a call
  // waiting out a 429 or a 5xx must not sit through the whole delay after the
  // caller gave up. Marked handled, so a signal that fires after the call
  // finished never surfaces as an unhandled rejection.
  let onAbort = (): void => {}
  const abortion =
    abort &&
    new Promise<never>((_, reject) => {
      onAbort = () => reject(abort.reason ?? new Error("aborted"))
      abort.addEventListener("abort", onAbort, { once: true })
    })
  abortion?.catch(() => {})
  const pause = (ms: number): Promise<void> =>
    abortion ? Promise.race([config.sleep(ms), abortion]) : config.sleep(ms)
  try {
    return await attempts()
  } finally {
    abort?.removeEventListener("abort", onAbort)
  }

  async function attempts(): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    // An abort that already happened sends nothing at all.
    if (abort?.aborted) throw abort.reason ?? new Error("aborted")
    // A fresh signal per attempt, and a real one: without it a "timeout" only
    // abandons the promise — the socket stays open and the server keeps working.
    // The transport is ALSO raced against the signal, so a transport that ignores
    // `init.signal` still cannot outlive the deadline. No signal for Infinity.
    const timeout = Number.isFinite(config.timeoutMs)
      ? AbortSignal.timeout(Math.min(config.timeoutMs, MAX_TIMEOUT_MS))
      : undefined
    // The caller's signal rides alongside the deadline: either one aborts the
    // attempt. `AbortSignal.any` is Node 20.3+ and every current browser; where it
    // is missing the caller's signal alone is honored only when there is no deadline.
    const signal =
      timeout && abort
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([timeout, abort])
          : timeout
        : (timeout ?? abort)
    let onAbort = (): void => {}
    const deadline =
      signal &&
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
      })
    const race = <T,>(work: Promise<T>): Promise<T> => (deadline ? Promise.race([work, deadline]) : work)

    let received: { status: number; retryAfter: string | null; body: unknown }
    try {
      const response: unknown = await race(config.fetch(url, { ...init, signal }))
      if (!isResponseLike(response)) throw new NotAResponse()
      const text = await race(response.text())
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
      received = {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: parsed,
      }
    } catch (cause) {
      if (cause instanceof NotAResponse) {
        throw new TelemError("the injected fetch returned something that is not a Response", {
          code: "connection_error",
        })
      }
      // The caller aborted: surface their reason, exactly as fetch would, no retry.
      if (abort?.aborted) throw abort.reason ?? cause
      // A timeout is the caller's own patience running out, not a transient fault:
      // retrying it would multiply the wall-clock wait they asked to cap.
      if (signal?.aborted) {
        throw new TimeoutError(`request to ${url} timed out after ${config.timeoutMs}ms`, cause)
      }
      if (attempt >= config.maxRetries) throw connectionError(url, cause)
      await pause(backoff(attempt))
      continue
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }

    // The whole 2xx range is success; only the search version gate may reject one.
    if (received.status >= 200 && received.status < 300) return received.body
    if (isRetryable(received.status) && attempt < config.maxRetries) {
      await pause(retryDelay(received.retryAfter, attempt))
      continue
    }
    throw statusError(received.status, received.body)
  }
  }
}
