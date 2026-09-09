// The public surface: one client class, a thin facade over the method modules.
//
// Async-only, one class, zero runtime dependencies: the transport is bare `fetch`,
// injectable through the constructor so the package runs embedded, on Workers/edge,
// and in tests.

import { resolveConfig, type ResolvedConfig } from "./config.ts"
import { fetchUrls } from "./methods/fetch.ts"
import { providers as listProviders } from "./methods/providers.ts"
import { search as runSearch } from "./methods/search.ts"
import { createSessions } from "./methods/sessions.ts"
import type {
  FetchOptions,
  FetchResponse,
  ProviderInfo,
  SearchOptions,
  SearchResponse,
  SessionsResource,
  TelemOptions,
} from "./types.ts"

export { TelemError, TimeoutError } from "./errors.ts"
export type { TelemClientErrorCode, TelemErrorOptions } from "./errors.ts"
// Trajectory-v5 identity helpers — public so an integration can derive an envelope
// and thread it onto a call. `withTrajectory` is the seam; the reserved `TRAJECTORY`
// symbol is deliberately NOT exported — the function is the only door.
export {
  RESERVED_METADATA,
  buildMetadata,
  buildSnapshot,
  contentAnchor,
  eventNodeKey,
  fingerprint,
  sessionKey,
  snapshotNodeKey,
  toolMarker,
  windowAnchor,
  withTrajectory,
} from "./trajectory.ts"
export type { SnapshotArgs, TrajectoryArgs, TrajectoryEnvelope, TrajectorySnapshot } from "./types.ts"
export type {
  FetchOptions,
  FetchResponse,
  FetchResult,
  Json,
  ProviderInfo,
  ProviderRun,
  SearchDefaults,
  SearchOptions,
  SearchResponse,
  SearchResult,
  SessionResults,
  SessionsResource,
  SessionSummary,
  TelemOptions,
} from "./types.ts"

/**
 * The Telem client.
 *
 * @example
 * ```ts
 * const telem = new Telem                    // env / credentials-file resolution
 * const telem = new Telem("tlm_...")           // bare API-key shorthand
 * const telem = new Telem({ apiKey, baseUrl, tier: "max" })
 * ```
 */
export class Telem {
  /** Resolved API key, or `undefined` for an anonymous client. */
  readonly apiKey?: string
  /** Resolved base URL, trailing slash stripped. */
  readonly baseUrl: string
  /** Resolved per-request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Resolved retry budget (attempts after the first). */
  readonly maxRetries: number
  /** The session read surface: `list` and `results(id)`. */
  readonly sessions: SessionsResource

  readonly #config: ResolvedConfig

  /**
   * @param options - An API key string, or an options object. Anything left unset
   *   resolves from `TELEM_*` env vars, then `~/.telem/credentials.json` (credentials
   *   only, read lazily), then the defaults.
   */
  constructor(options: string | TelemOptions = {}) {
    const config = resolveConfig(options)
    this.#config = config
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl
    this.timeoutMs = config.timeoutMs
    this.maxRetries = config.maxRetries
    this.sessions = createSessions(config)
  }

  /**
   * Run a web search.
   *
   * @param query - One query, or an array of queries batched into one interaction.
   * @param options - Per-call options; each overrides the matching client default.
   *   `null` and `undefined` both mean none.
   * @returns The flattened results plus the per-provider breakdown.
   */
  async search(query: string | string[], options?: SearchOptions | null): Promise<SearchResponse> {
    return await runSearch(this.#config, query, options ?? {})
  }

  /**
   * Fetch the readable content of one or more URLs.
   *
   * @param url - One URL, or an array of URLs fetched in one request.
   * @param options - Per-call fetch options. `null` and `undefined` both mean none.
   * @returns One result per requested URL, in request order.
   */
  async fetch(url: string | string[], options?: FetchOptions | null): Promise<FetchResponse> {
    return await fetchUrls(this.#config, url, options ?? {})
  }

  /**
   * List the search providers this deployment can run.
   *
   * @returns One entry per configured provider, in the server's own order.
   */
  async providers(): Promise<ProviderInfo[]> {
    return await listProviders(this.#config)
  }
}

export default Telem
