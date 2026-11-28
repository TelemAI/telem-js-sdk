// Exactly two error classes: every non-2xx and every transport failure normalizes
// into one of these. No bare `Error` ever escapes the client. Callers branch on
// `status`/`code`, never on subclasses.

import type { MonitorBatchResult } from "./types.ts"

/**
 * The CLOSED set of codes the client itself assigns, for failures that never
 * reached the server or that the server's own envelope does not describe. Any
 * other value came off the wire (the `/v1/fetch` envelope's `error.code`) and is
 * passed through untouched.
 *
 * Branch on these, never on message text — messages are not a contract.
 */
export type TelemClientErrorCode =
  /** The arguments were rejected before any request was made. */
  | "invalid_request"
  /** A 2xx search response did not echo `normalized_schema_version >= 2`. */
  | "unsupported_server_version"
  /** The request never produced a response (DNS, refused, reset, TLS). */
  | "connection_error"
  /** The request was still outstanding when the timeout fired. */
  | "timeout"
  /** A 2xx body carried a value the client cannot use safely, such as a change-stream
   *  position (`seq`, `watermark`, `next_cursor`) that is not a whole number. */
  | "invalid_response"
  /** `monitors.createMany` was aborted after it sent a call: `cause` is the reason. */
  | "aborted"

export type TelemErrorOptions = {
  /** HTTP status that produced this error; absent for transport failures. */
  status?: number
  /** A `TelemClientErrorCode`, or the stable code the server's envelope carried.
   *  Absent when a non-2xx response named no code of its own. */
  code?: TelemClientErrorCode | (string & {})
  /** Parsed response body (or raw text when it would not parse). */
  details?: unknown
  cause?: unknown
  /** The response's `Retry-After`, in seconds, when it sent one as a number. */
  retryAfter?: number
}

export class TelemError extends Error {
  status?: number
  code?: TelemClientErrorCode | (string & {})
  details?: unknown
  /** The response's `Retry-After`, in seconds, when it sent one as a number. */
  declare retryAfter?: number
  /** From `monitors.createMany`: each monitor's last answer before it failed, in order.
   *  Not enumerable, so serialising the error does not write a `webhookSecret`. */
  declare results?: MonitorBatchResult[]
  /** From `monitors.createMany`: every monitor's key, in order. Not enumerable. */
  declare idempotencyKeys?: string[]

  constructor(message: string, options: TelemErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "TelemError"
    this.status = options.status
    this.code = options.code
    this.details = options.details
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter
  }
}

/** The request never produced a response in time. Always `code: "timeout"`. */
export class TimeoutError extends TelemError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "timeout", cause })
    this.name = "TimeoutError"
  }
}
