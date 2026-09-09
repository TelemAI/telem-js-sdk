// Hand-written response interfaces (no runtime response validation).
//
// The SDK-facing shape is camelCase throughout; `raw` on every object carries the
// server's own snake_case payload verbatim for anything not modelled here.

export type Json = Record<string, unknown>

// --------------------------------------------------------------------------- //
// Trajectory-v5 lineage
// --------------------------------------------------------------------------- //

/** What one event node needs to identify itself, before derivation. Every id here
 *  is an OPAQUE host string; the UUIDs that reach the wire are derived from them by
 *  `buildMetadata`, never forwarded. */
export type TrajectoryArgs = {
  harness: string
  conversationId: string
  windowId: string
  messageId: string
  toolCallId: string
  /** The flattened conversation history, in the backend's `{role, content}` shape. */
  history: readonly Record<string, string>[]
  /** The root-first ancestor chain; its LAST entry is the direct parent. */
  ancestors: readonly Json[]
}

/** A derived, wire-ready trajectory envelope: the output of `buildMetadata`, and the
 *  only thing `withTrajectory` should be handed. Its keys are the reserved lineage
 *  keys the freeform `metadata` bag may not carry, so they are snake_case — they land
 *  on the wire `metadata` verbatim, with the node's `kind` stamped by the call that
 *  sends it. Build it with `buildMetadata`; do not hand-assemble one, or the derived
 *  ids will not join the backend's rows. */
export type TrajectoryEnvelope = {
  message_history: readonly Record<string, string>[]
  session_key: string
  fingerprint: string
  node_key: string
  parent_node_key: string | null
  ancestors: readonly Json[]
}

/** What freezes one agent at a delegation boundary, before derivation. */
export type SnapshotArgs = {
  harness: string
  conversationId: string
  windowId: string
  /** The model turn that delegated; subagents started in one turn share the node. */
  messageId: string
  /** The agent's conversation so far, frozen at the boundary. */
  context: readonly Record<string, string>[]
  /** The agent's own root-first ancestor chain. */
  ancestors: readonly Json[]
  /** ISO timestamp; defaults to now. */
  spawnedAt?: string
}

/** One entry of a child's `ancestors`: the output of `buildSnapshot`. */
export type TrajectorySnapshot = {
  session_key: string
  fingerprint: string
  node_key: string
  parent_node_key: string | null
  context: readonly Record<string, string>[]
  spawned_at: string
}

// --------------------------------------------------------------------------- //
// Options
// --------------------------------------------------------------------------- //

/** Search options. `undefined` is unset (client default, then server default);
 *  `[]`/`{}`/`false` are explicit values sent to the server as-is. */
export type SearchOptions = {
  tier?: string
  fields?: string[]
  providersInclude?: string[]
  providersExclude?: string[]
  providerOverrides?: Record<string, Json>
  numResults?: number
  includeRaw?: boolean
  includeFullContent?: boolean
  /** Opt this request into the server's rerank stage. It is the only path where
   *  `context`, the reasoning on the last assistant entry of the lineage history
   *  (that entry only), and `goal` change result ORDER (in that precedence) —
   *  otherwise they are recorded only. Per-call intent, like `includeRaw`; the
   *  server default is off, and rerank is metered. */
  rerank?: boolean
  goal?: string
  context?: string
  session?: string
  /** Abort this call: the request stops, no retry follows, and the call rejects
   *  with the signal's reason. Merged with the per-attempt timeout. */
  signal?: AbortSignal
  /** Freeform metadata for the wire. Reserved trajectory-lineage keys
   *  (`RESERVED_METADATA`) are STRIPPED from here — lineage may only be attached
   *  through `withTrajectory`, fed by `buildMetadata`, never smuggled in as data. */
  metadata?: Json
}

/** The subset of search options that may also be set as a client default.
 *  `numResults`/`includeRaw`/`rerank`/`providerOverrides` are per-call intent only. */
export type SearchDefaults = Pick<
  SearchOptions,
  "tier" | "fields" | "providersInclude" | "providersExclude" | "includeFullContent"
>

export type FetchOptions = {
  providers?: string[]
  inlineContent?: boolean
  inlineMaxChars?: number
  contentFormat?: string
  session?: string
  /** Abort this call: the request stops, no retry follows, and the call rejects
   *  with the signal's reason. Merged with the per-attempt timeout. */
  signal?: AbortSignal
  metadata?: Json
}

export type TelemOptions = SearchDefaults & {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  /** Injectable transport — embedded runtimes, edge workers, and tests. */
  fetch?: typeof globalThis.fetch
  userAgent?: string
  /** Retry backoff seam. Defaults to a real timer; tests pass a recorder. */
  sleep?: (ms: number) => Promise<void>
}

// --------------------------------------------------------------------------- //
// Search responses
// --------------------------------------------------------------------------- //

// Every field below is ALWAYS PRESENT. A JSON `null` from the server stays a
// `null` here — it is never softened to `undefined` and the key is never dropped,
// so `"title" in result` and `Object.keys` mean the same thing for every
// response, and `x === null` is the one check for "the server said nothing".
// (`url`/`title` are the two exceptions the server forces: it emits `title: null`
// routinely, and both are coerced to `""`.

export type SearchResult = {
  url: string
  title: string
  summary: string | null
  excerpt: string[] | null
  fullContent: Json | null
  publishDate: string | null
  rank: number | null
  thumbnail: string | null
  favicon: string | null
  source: Json | null
  enrichments: Json | null
  fetchMeta: Json | null
  provider: string
  raw: Json
}

export type ProviderRun = {
  provider: string
  status: string
  results: SearchResult[]
  error: Json | null
  latencyMs: number | null
  preprocessorRunId: string | null
  tier: string | null
  fields: string[]
  query: string
  batchIndex: number
  answer: string | null
  entities: Json | unknown[] | null
  related: Json | null
  verticals: Json | null
  usage: Json | unknown[] | null
  warnings: Json[]
  raw: Json | null
}

export type SearchResponse = {
  /** Flattened across providers: provider run order, then envelope row order. */
  results: SearchResult[]
  /** Per-provider breakdown, preserving partial failures. */
  byProvider: ProviderRun[]
  sessionId: string
  interactionId: string
  status: string
  normalizedSchemaVersion: number | null
  raw: Json
}

// --------------------------------------------------------------------------- //
// Fetch responses
// --------------------------------------------------------------------------- //

export type FetchResult = {
  url: string
  canonicalUrl: string | null
  title: string
  status: string
  content: string | null
  contentTruncated: boolean | null
  contentFormat: string | null
  contentSha256: string | null
  contentType: string | null
  contentRef: Json | null
  provider: string
  httpStatus: number | null
  fetchedAt: string | null
  latencyMs: number | null
  providerMetadata: Json | null
  error: Json | null
  batchIndex: number
  raw: Json
}

export type FetchResponse = {
  /** One result per requested URL, in request (batchIndex) order. */
  results: FetchResult[]
  sessionId: string
  interactionId: string
  status: string
  raw: Json
}

// --------------------------------------------------------------------------- //
// Catalog
// --------------------------------------------------------------------------- //

export type ProviderInfo = {
  name: string
  type: string
  activeByDefault: boolean
  description: string | null
  method: string | null
  url: string | null
  normalized: boolean
  tiers: string[]
}

// --------------------------------------------------------------------------- //
// Sessions
// --------------------------------------------------------------------------- //

/** One session as `sessions.list` reports it. */
export type SessionSummary = {
  id: string
  createdAt: string | null
  updatedAt: string | null
  interactionCount: number
  latestInteractionAt: string | null
  raw: Json
}

/** Aggregated websearch preprocessor results for a session. `query`, `goal` and
 *  `context` are always strings — a server that said nothing sends `""`, never null. */
export type SessionResults = {
  sessionId: string
  query: string
  goal: string
  context: string
  previousPreprocessorResults: Json[]
  raw: Json
}

/** The `telem.sessions` namespace. */
export type SessionsResource = {
  list(): Promise<SessionSummary[]>
  results(sessionId: string): Promise<SessionResults>
}
