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
  autoRouting?: string
  maxRoutingProviders?: number
  topic?: string
  /** Only results published on or after this date or date-time: an ISO 8601 string
   *  (no time zone means UTC) or a `Date`. Results with no known date are kept.
   *  Per-call only, like the two below. */
  publishedAfter?: string | Date
  /** Only results published before this date or date-time. A date with no time
   *  includes that whole day. A `Date` is an exact instant; pass a "YYYY-MM-DD"
   *  string to include the whole day. */
  publishedBefore?: string | Date
  /** Only results from these domains: at most 20 hostnames such as `"linkedin.com"`.
   *  A subdomain such as `"uk.linkedin.com"` matches its domain. Per-call only. */
  includeDomains?: string[]
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
  | "tier"
  | "fields"
  | "providersInclude"
  | "providersExclude"
  | "includeFullContent"
  | "autoRouting"
  | "maxRoutingProviders"
  | "topic"
>

export type FetchOptions = {
  /** Fetch provider chain, in order. Defaults to `TELEM_FETCH_PROVIDERS`. */
  providers?: string[]
  inlineContent?: boolean
  inlineMaxChars?: number
  contentFormat?: string
  /** Fetch tier: `minimalist`, `default`, `extended` or `max`. Sent as given; the
   *  server rejects an unknown one. Defaults to `TELEM_FETCH_TIER`, lowercased. */
  tier?: string
  /** `true` reads every page live and skips the shared fetch cache. Defaults to
   *  `TELEM_FETCH_NO_CACHE` (on with exactly `"1"`); `false` overrides it. */
  noCache?: boolean
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
  /** Monitor polls: results folded as the same story, `{leadUrl: [{url, title}]}`. */
  sameStory: Record<string, Json[]> | null
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
  /** Whether auto-routing can pick it; `null` from a router that does not say. */
  autoRouted: boolean | null
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

// --------------------------------------------------------------------------- //
// Monitors
// --------------------------------------------------------------------------- //

/** The search options a monitor can run on its schedule (`MonitorCreateOptions.search`). */
export type MonitorSearchOptions = Pick<SearchOptions, "tier" | "numResults">

/** The options of `monitors.create` that a monitor takes with the agent or without. */
export type MonitorCreateCommonOptions = {
  /** `"1h"`, `"6h"`, `"12h"`, `"1d"` or `"7d"`. If you leave it out, the monitor runs once a day. */
  frequency?: string
  /** Also run a web search for the query on the schedule, with these options. `{}`
   *  uses the defaults. Client search defaults do not apply. It adds to what a poll returns. */
  search?: MonitorSearchOptions
  /** Only results from these sites and their subdomains, such as `["sec.gov"]`, in what
   *  a poll returns. */
  includeDomains?: string[]
  /** Query lineage keys, sent as given. They choose the session that records the polls of
   *  the monitor. */
  metadata?: Json
  /** An `https` URL that receives the new results. */
  webhookUrl?: string
  signal?: AbortSignal
}

// The monitor with the agent comes last: TypeScript checks a union member by member and
// reports the last one, so leaving out `ttl` reads as "Property 'ttl' is missing".
/** Options for `monitors.create`. A monitor has the agent unless `agent` is `false`,
 *  and a monitor with the agent must end: then `ttl` is required. */
export type MonitorCreateOptions = MonitorCreateCommonOptions &
  (
    | {
        /** `false` creates a monitor without an agent, which you read with the deprecated
         *  `monitors.poll`. */
        agent: false
        /** End the monitor after this long, such as `"7d"` or `"30d"` (at most `"30d"`).
         *  Without it, a monitor without an agent never ends. */
        ttl?: string
      }
    | {
        /** Start the monitor agent with the monitor, the default: it checks every result
         *  against the query and keeps the ones that match. Read what it keeps with
         *  `monitors.iterateChanges` or `monitors.changes`. */
        agent?: true
        /** End the monitor after this long, such as `"7d"` or `"30d"` (at most `"30d"`).
         *  Required with the agent. */
        ttl: string
      }
  )

/** Options for `monitors.update`. Send at least one field. */
export type MonitorUpdateOptions = {
  /** `"paused"` or `"active"`. */
  status?: string
  frequency?: string
  /** A new webhook URL, with a new `webhookSecret` in the response. `null` or `""` removes it. */
  webhookUrl?: string | null
  /** A new end, this long from now, such as `"30d"` (at most `"30d"`). It renews a monitor
   *  before it ends; an ended monitor cannot be renewed. */
  ttl?: string
  signal?: AbortSignal
}

/** Options for `monitors.poll`.
 *  @deprecated `poll` is deprecated: read the agent with `monitors.iterateChanges`. */
export type MonitorPollOptions = {
  /** Record this poll in another session (default: the monitor's own). */
  session?: string
  /** Request metadata (query lineage keys), sent as given. */
  metadata?: Json
  signal?: AbortSignal
}

/** A monitor: a query that Telem runs on a schedule. */
export type Monitor = {
  id: string
  query: string
  frequency: string
  /** `active`, `paused` (you paused it) or `ended` (past `expiresAt`). */
  status: string
  sessionId: string
  createdAt: string
  lastPolledAt: string | null
  /** When the monitor ends; `null`: never. */
  expiresAt: string | null
  webhookUrl: string | null
  /** Signs the webhook deliveries. Only in the response that set `webhookUrl`. */
  webhookSecret: string | null
  /** The monitor agent's state. `null`: the monitor has no agent. Absent when the router
   *  sends none, as a router from before the agent reads does. */
  agentState?: AgentState | null
  /** Only in the answer to a create: why the monitor agent did not start, or not yet.
   *  `null` when it started, and in every other answer. */
  agentNote: string | null
  raw: Json
}

/** The latest compile of an agent's plan (`AgentState.compile`). */
export type AgentCompileState = {
  jobId: string
  /** The compile job's status, such as `done` or `failed`. */
  status: string
  /** Why the compile failed; `null` when it did not. */
  error: string | null
}

/** The state of a monitor's agent: `monitor.agentState`. */
export type AgentState = {
  /** The agent engine, `"v4"` today. */
  engine: string
  /** Such as `compiling`, `ready`, `paused` or `failed`. */
  status: string
  /** `true` when `status` is `failed`. */
  needsAttention: boolean
  /** The version of the agent's plan; `null` before it has one. */
  planVersion: number | null
  /** When the agent runs next; `null` when no run is scheduled. */
  nextRunAt: string | null
  /** The `seq` of the newest change `monitors.changes` can serve now. */
  watermark: number
  /** The latest compile of the plan; `null` when there has been none. */
  compile: AgentCompileState | null
}

/** The monitor agent's document: `monitors.agent`. A field is there only when the
 *  router sent it. The rest of the document (the plan, the counts, the runs) is in `raw`. */
export type AgentDocument = {
  /** Such as `compiling`, `ready`, `paused`, `failed` or `ended`. */
  status?: string
  query?: string
  frequency?: string
  /** The version of the plan; 0 while the agent compiles. */
  specVersion?: number
  /** The agent's spending limits; `null` when none are set. */
  budget?: Json | null
  /** What the agent has spent, in US dollars. */
  spendUsd?: number
  raw: Json
}

/** The item a change is about. `entityId` is `null` for a change to the whole monitor,
 *  such as a run or a plan change. */
export type ChangeSubject = {
  entityId: string | null
  name: string | null
}

/** One change the monitor agent made. */
export type ChangeRecord = {
  /** The change's place in the stream. It grows with every change and is never reused.
   *  Pass the last one you handled as `cursor` to read on from there. */
  seq: number
  /** The change's own type, such as `new_object`. */
  type: string
  /** What happened: one of the six kinds `entity_added`, `value_changed`,
   *  `fact_status_changed`, `alert`, `run` or `plan_changed`. */
  kind: string
  monitorId: string
  subject: ChangeSubject
  /** What it was before, as the router sent it; `null` when there is no before. Its shape
   *  depends on `kind`. */
  before: unknown
  /** What it is now, as the router sent it. */
  after: unknown
  /** The facts behind the change; empty when the router names none. */
  factIds: string[]
  /** When it happened, ISO 8601. */
  at: string
  raw: Json
}

/** One page of `monitors.changes`. */
export type ChangesPage = {
  changes: ChangeRecord[]
  /** Keep this and pass it as `cursor` to read the changes after this page. On a full
   *  page (`limit` changes) it is the `seq` of the last change. On a shorter page, an
   *  empty one included, it is `watermark`: the read got that far, past the changes
   *  that `kinds` left out too. */
  nextCursor: number
  /** The `seq` of the newest change that can be read now. You are caught up when
   *  `nextCursor` equals it, or when a page is empty. */
  watermark: number
}

/** Options for `monitors.changes`. */
export type MonitorChangesOptions = {
  /** Read the changes after this `seq`. If you leave it out, the page starts at the
   *  first change. Do not send it with `since`. */
  cursor?: number
  /** Read from this time on: a `Date`, or an ISO 8601 time with an offset such as
   *  `"2026-11-03T12:00:00Z"`. Do not send it with `cursor`. */
  since?: string | Date
  /** Only these kinds of change: `entity_added`, `value_changed`, `fact_status_changed`,
   *  `alert`, `run` or `plan_changed`, for example `["alert", "run"]`. Another name is a
   *  400 (`kinds_invalid`). An empty list is no filter. */
  kinds?: string[]
  /** How many changes to return (server default 200, maximum 500). */
  limit?: number
  signal?: AbortSignal
}

/** Options for `monitors.iterateChanges`. */
export type MonitorIterateChangesOptions = {
  /** Read the changes after this `seq`. If you leave it out, the walk starts at the
   *  first change. */
  cursor?: number
  signal?: AbortSignal
}

/** Options for `monitors.list` and `monitors.listPage`. */
export type MonitorListOptions = {
  /** How many to return (server default 50, maximum 200). */
  limit?: number
  /** The `nextCursor` of the page before. */
  cursor?: string
  signal?: AbortSignal
}

/** One page of `monitors.listPage`. */
export type MonitorPage = {
  monitors: Monitor[]
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null
}

/** The `telem.monitors` namespace. */
export type MonitorsResource = {
  /** Create a monitor. It has the agent unless `agent` is `false`, and with the agent
   *  `ttl` is required: a create without it throws a `TelemError` (`invalid_request`)
   *  before anything is sent. */
  create(query: string, options: MonitorCreateOptions): Promise<Monitor>
  list(options?: MonitorListOptions): Promise<Monitor[]>
  listPage(options?: MonitorListOptions): Promise<MonitorPage>
  get(monitorId: string, options?: { signal?: AbortSignal }): Promise<Monitor>
  update(monitorId: string, options: MonitorUpdateOptions): Promise<Monitor>
  /** Get the monitor's own results that are new since the last poll.
   *  @deprecated Read what the monitor agent finds with `iterateChanges` or `changes`.
   *  A poll still works, and warns once per process with `console.warn`. */
  poll(monitorId: string, options?: MonitorPollOptions): Promise<SearchResponse>
  delete(monitorId: string, options?: { signal?: AbortSignal }): Promise<void>
  /** Read the monitor agent's document. A monitor without an agent answers 404. */
  agent(monitorId: string, options?: { signal?: AbortSignal }): Promise<AgentDocument>
  /** One page of the agent's changes. Keep `nextCursor` and pass it back as `cursor`. */
  changes(monitorId: string, options?: MonitorChangesOptions): Promise<ChangesPage>
  /** Every change after `cursor`, page by page, until you are caught up. */
  iterateChanges(
    monitorId: string,
    options?: MonitorIterateChangesOptions,
  ): AsyncGenerator<ChangeRecord, void, undefined>
}
