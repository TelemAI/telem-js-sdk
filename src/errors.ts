// Exactly two error classes: every non-2xx and every transport failure normalizes
// into one of these. No bare `Error` ever escapes the client. Callers branch on
// `status`/`code`, never on subclasses.

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

export type TelemErrorOptions = {
  /** HTTP status that produced this error; absent for transport failures. */
  status?: number
  /** A `TelemClientErrorCode`, or the stable code the server's envelope carried.
   *  Absent when a non-2xx response named no code of its own. */
  code?: TelemClientErrorCode | (string & {})
  /** Parsed response body (or raw text when it would not parse). */
  details?: unknown
  cause?: unknown
}

export class TelemError extends Error {
  status?: number
  code?: TelemClientErrorCode | (string & {})
  details?: unknown

  constructor(message: string, options: TelemErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "TelemError"
    this.status = options.status
    this.code = options.code
    this.details = options.details
  }
}

/** The request never produced a response in time. Always `code: "timeout"`. */
export class TimeoutError extends TelemError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "timeout", cause })
    this.name = "TimeoutError"
  }
}
