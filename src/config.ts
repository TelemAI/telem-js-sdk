// Config resolution: call argument -> constructor option -> TELEM_* env ->
// ~/.telem/credentials.json -> defaults. The Python twin is telem/_base.py (search
// defaults + credential precedence) plus the credentials half of
// telem/_config_files.py.
//
// Repo-local .telem/telem.json is deliberately NEVER read: a library must not let a
// checked-out repository steer an arbitrary program's spend. credentials.json is the
// SDK's ONE config file, and it holds credentials only.

import { TelemError } from "./errors.ts"
import type { SearchDefaults, TelemOptions } from "./types.ts"
import { VERSION } from "./version.ts"

/** The hosted deployment. A default, not a requirement — an ordinary user should not
 *  have to know where Telem runs, and TELEM_BASE_URL points elsewhere. */
export const DEFAULT_BASE_URL = "https://router.telem.ai"
/** The server grants provider timeouts of up to 60 s at the `max` tier. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Attempts after the first. */
export const DEFAULT_MAX_RETRIES = 2

type Env = Record<string, string | undefined>

/** Everything the transport and the methods need, with nothing left to resolve. */
export type ResolvedConfig = {
  apiKey?: string
  baseUrl: string
  timeoutMs: number
  maxRetries: number
  userAgent: string
  /** The transport: the injected one, else the platform `fetch`. */
  fetch: typeof globalThis.fetch
  sleep: (ms: number) => Promise<void>
  defaults: SearchDefaults
}

// The blank list shared with the config-core option table and the Python SDK's _config_files.py: a
// CLOSED set (the six ASCII blanks plus NBSP, BOM and the ideographic space — what a
// PASTE actually deposits), because JS `.trim` and Python `.strip` disagree and the
// same file must resolve to the same config in both languages. Escapes, not literals:
// an invisible character is not a readable definition.
const BLANK = /^[ \t\n\r\v\f\u00a0\ufeff\u3000]+|[ \t\n\r\v\f\u00a0\ufeff\u3000]+$/g

function trimBlank(value: string): string {
  return value.replace(BLANK, "")
}

/** Parse a comma-separated env var into names, or `undefined` when unset.
 *  Items are trimmed with the SHARED blank list above — not JS's own `.trim`, whose
 *  idea of whitespace differs from Python's — and empties dropped, so an all-empty value
 *  is unset: an env var can never express an explicit empty list, only a constructor or
 *  call argument can. */
function csvEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const items = raw
    .split(",")
    .map(trimBlank)
    .filter((item) => item !== "")
  return items.length ? items : undefined
}

/** Parse an integer env var, or `undefined` when it is unset or not an integer. */
function intEnv(raw: string | undefined): number | undefined {
  return raw !== undefined && /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : undefined
}

/**
 * Read `~/.telem/credentials.json` (the file the installer writes) into
 * `{apiKey?, baseUrl?}`. It NEVER raises and NEVER prints: a library that writes to a
 * host application's stderr because a file it was never told about is malformed is a
 * library that gets vendored around. A missing, malformed, or partial file simply
 * supplies nothing and the caller's defaults stand.
 *
 * Reached through `process.getBuiltinModule` rather than an import, so the package has
 * no filesystem module in its import graph at all and still loads on Workers/edge —
 * where `getBuiltinModule` is absent and this quietly supplies nothing.
 */
function readCredentials(env: Env): { apiKey?: string; baseUrl?: string } {
  try {
    const proc: typeof globalThis.process | undefined = globalThis.process
    if (typeof proc?.getBuiltinModule !== "function") return {}
    const home = trimBlank(env.HOME || env.USERPROFILE || "")
    // TELEM_CONFIG_DIR relocates the directory, GH_CONFIG_DIR-style: the value IS it.
    const dir = trimBlank(env.TELEM_CONFIG_DIR || "") || (home && `${home}/.telem`)
    if (!dir) return {}
    const path = `${dir.replace(/[/\\]+$/, "")}/credentials.json`
    // Read bytes and decode STRICTLY, mirroring the Python reader: a file that is not
    // valid UTF-8 is absent rather than silently used with replacement characters, and
    // reading raw keeps newline translation out of the picture so both see the same text.
    const bytes = proc.getBuiltinModule("node:fs").readFileSync(path)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    // Exactly one leading byte-order mark, as the Python mirror strips: Windows
    // Notepad writes one and JSON.parse rejects it.
    const data: unknown = JSON.parse(text.replace(/^\ufeff/, ""))
    if (!data || typeof data !== "object" || Array.isArray(data)) return {}
    const out: { apiKey?: string; baseUrl?: string } = {}
    for (const key of ["apiKey", "baseUrl"] as const) {
      const value = (data as Record<string, unknown>)[key]
      if (typeof value !== "string") continue
      const trimmed = trimBlank(value)
      if (trimmed) out[key] = trimmed
    }
    return out
  } catch {
    return {}
  }
}

/** A constructor argument the client cannot work with. Raised at construction, so
 *  a bad value is found where it was written rather than on the first call. */
function invalidOption(message: string): TelemError {
  return new TelemError(message, { code: "invalid_request" })
}

/** Resolve constructor input into the client's frozen configuration. */
export function resolveConfig(options: string | TelemOptions): ResolvedConfig {
  const opts: TelemOptions = typeof options === "string" ? { apiKey: options } : options
  const env: Env = (globalThis.process?.env as Env | undefined) ?? {}

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) {
    throw invalidOption(`timeoutMs must be a positive number of milliseconds (Infinity for no timeout), got ${String(timeoutMs)}`)
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw invalidOption(`maxRetries must be a whole number of retries, got ${String(maxRetries)}`)
  }
  const send = opts.fetch ?? globalThis.fetch
  if (typeof send !== "function") {
    throw invalidOption("no fetch on this runtime: pass one with the `fetch` option")
  }

  // Credentials: argument, else env var, else the credentials file — read ONLY when
  // something is still unresolved, per key, so a fully-configured caller (and every
  // caller on a runtime with no filesystem) never touches the disk.
  let apiKey = opts.apiKey || env.TELEM_API_KEY || undefined
  let baseUrl = opts.baseUrl || env.TELEM_BASE_URL || undefined
  if (apiKey === undefined || baseUrl === undefined) {
    const credentials = readCredentials(env)
    apiKey = apiKey ?? credentials.apiKey
    baseUrl = baseUrl ?? credentials.baseUrl
  }

  const resolvedBaseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")
  let scheme: string | undefined
  try {
    scheme = new URL(resolvedBaseUrl).protocol
  } catch {
    scheme = undefined
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw invalidOption(`baseUrl must be an http(s) URL, got ${JSON.stringify(resolvedBaseUrl)}`)
  }

  return {
    apiKey,
    baseUrl: resolvedBaseUrl,
    timeoutMs,
    maxRetries,
    userAgent: opts.userAgent || `telem-sdk-js/${VERSION}`,
    fetch: send,
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    // Search defaults: constructor option, else env var, else unset. Only `undefined`
    // is unset — `[]`/`false` are explicit values sent to the server verbatim.
    // numResults/includeRaw/providerOverrides are per-call intent and are not read
    // here at all, so passing one as a client default is inert.
    defaults: {
      tier: opts.tier ?? (env.TELEM_TIER || undefined),
      fields: opts.fields ?? csvEnv(env.TELEM_FIELDS),
      providersInclude: opts.providersInclude ?? csvEnv(env.TELEM_PROVIDERS_INCLUDE),
      providersExclude: opts.providersExclude ?? csvEnv(env.TELEM_PROVIDERS_EXCLUDE),
      includeFullContent: opts.includeFullContent ?? (env.TELEM_FULL_CONTENT === "1" || undefined),
      autoRouting: opts.autoRouting ?? (trimBlank(env.TELEM_AUTO_ROUTING ?? "") || undefined),
      maxRoutingProviders: opts.maxRoutingProviders ?? intEnv(env.TELEM_MAX_ROUTING_PROVIDERS),
      topic: opts.topic ?? (trimBlank(env.TELEM_TOPIC ?? "") || undefined),
    },
  }
}
