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
  /** `"images"`: an image search on brave only; each result adds `imageUrl`, `imageWidth`
   *  and `imageHeight`. */
  topic?: string
  // Unpublished (2026-11-27): the search vertical, sent as `search.vertical` ("health",
  // "general"; the router 400s an unknown name). Wins over the client default. Not
  // documented until the router accepts the field.
  vertical?: string
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
  | "vertical"
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
  // Unpublished: the canonical name of the `vertical` client default (both are
  // accepted; two different values are refused). Falls back to TELEM_VERTICAL. It is
  // also sent as `inputs.vertical` on a monitor create with `inputs` that sets none.
  defaultVertical?: string
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  /** Retries after the first attempt: 2 by default. `monitors.create` retries for up
   *  to about 120 s instead, at most 60 times. A value you pass caps both. */
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
  /** Image searches (`topic: "images"`) only: the original image, its width and height. */
  imageUrl: string | null
  imageWidth: number | null
  imageHeight: number | null
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
  /** Labels of your own, to list the monitor by with `list({ tag })`: at most 10. Telem
   *  strips and lower-cases each one, which must then be 1 to 32 of `a-z`, `0-9`, `-` and
   *  `_`, starting with a letter or digit, and drops repeats. Anything else is a 422. */
  tags?: string[]
  /** The `Idempotency-Key` header, 1 to 255 visible ASCII characters. By default each
   *  call makes a new one. Pass your own to retry a create across a restart. */
  idempotencyKey?: string
  signal?: AbortSignal
}

/** What a monitor of a list of companies collects: the `inputs` of `monitors.create`.
 *  Sent as given, with the router's own field names, and checked by the router. */
export type MonitorInputs = {
  /** The companies, 1 to 20: rows of `company_id`, `name` and `domain`. */
  companies: Json[]
  /** People to watch: rows of `person_id`, `name`, `company_id` and `company`. */
  roster?: Json[]
  /** What to collect: the preset `"biopharma-v0"`, or a schema object. */
  schema?: string | Json
  /** Items to watch from the start: rows of `entity_id`, `kind` and `name`. */
  entities?: Json[]
  /** Kinds of event to collect: rows with a `label`. */
  categories?: Json[]
  /** `"propose"`: people found on company pages are proposed, for you to confirm.
   *  `"auto"`: they are watched at once. */
  discover?: string
  /** How many days back the first read of each company looks. */
  window_days?: number
  /** Look each company up before its first read, to find its other names and pages. */
  seed?: boolean
  // Unpublished: the search vertical of the monitor; wins over the client default.
  vertical?: string
}

/** The fields every result of a query monitor has, fixed by you: the `schema` of
 *  `monitors.create`. Not `MonitorInputs.schema`, which is for a monitor of a list of
 *  companies. Sent as given, with the router's own field names, and checked by the router. */
export type MonitorSchema = {
  /** 1 to 20 attributes. */
  attributes: MonitorSchemaAttribute[]
}

/** One attribute of a `MonitorSchema`: a field every result has, as you set it. */
export type MonitorSchemaAttribute = {
  /** The field's name, in snake_case, such as `"funding_round"`. */
  name: string
  type: "text" | "number" | "date" | "enum" | "bool"
  /** An enum's values, at most 50. */
  values?: string[]
  /** A literal enum's phrases that show each value: `{ value: [phrase, ...] }`. */
  evidence?: Record<string, string[]>
  /** A number's unit, such as `"USD"`. */
  unit?: string
  /** How the value is written, such as `"YYYY-MM-DD"`. */
  format?: string
  /** Where on the page the value is stated. Leave it out for the default. */
  where?: string
  /** An enum's grounding. */
  grounding?: "literal" | "classified"
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
        /** Only `false`: `presetStrict` needs the agent. */
        presetStrict?: false
      }
    | {
        /** Start the monitor agent with the monitor, the default: it checks every result
         *  against the query and keeps the ones that match. Read what it keeps with
         *  `monitors.iterateChanges` or `monitors.changes`. */
        agent?: true
        /** End the monitor after this long, such as `"7d"` or `"30d"` (at most `"30d"`, or
         *  `"365d"` with `inputs`). Required with the agent. */
        ttl: string
        /** Watch a list of companies: the companies, and the schema that says what to
         *  collect about them. Such a monitor has the agent. Read what the first read of
         *  each company found with `monitors.onboarding`. */
        inputs?: MonitorInputs
        /** The fields every result has: `"article"` (`headline`, `publication`,
         *  `published_at`, `summary`, `kind`), `"person"`, `"company"` or `"listing"`. The
         *  agent keeps them as they are and may add more (none with `presetStrict`). Leave
         *  it out and the agent picks the fields from the query. Refused with `inputs`. */
        preset?: MonitorPreset
        /** Whether the agent fetches each run's new search results before it reads them:
         *  `true`, `false`, or `{ on: true, capPerRun: 5 }` for at most that many pages a
         *  run (1 to 25, default 10). Leave it out and an article monitor fetches them, at
         *  most 10 a run. Refused with `inputs`. Read it back with `monitors.agent`. */
        fetchNewResults?: boolean | { on: boolean; capPerRun?: number }
        /** Fields of your own that every result has, kept as you set them. The agent may
         *  add fields of its own. With a `preset`, your field replaces the preset's field of
         *  the same name. Refused with `inputs`, before anything is sent: a monitor with
         *  `inputs` sets its fields in `inputs.schema`. Telem checks the rest and refuses a
         *  bad schema with a 422 whose `param` names the attribute. `monitors.agent` shows
         *  yours with `added_by: "caller"`. */
        schema?: MonitorSchema
        /** `true` keeps the agent to the `preset`'s fields and your `schema`: it adds none
         *  of its own, though it may still change a preset field's `where`, `unit` or
         *  `evidence`. Needs a `preset` and the agent; refused with `inputs`, before anything
         *  is sent. Chat may still add fields later. Read it back with `monitors.agent`. */
        presetStrict?: boolean
      }
  )

/** The `preset` of `monitors.create`. */
export type MonitorPreset = "article" | "person" | "company" | "listing"

/** One monitor of `monitors.createMany`: its `query` and the options of `create`.
 *  `idempotencyKey` is this monitor's own key; the call takes the `signal`. */
export type MonitorCreateManyItem = { query: string } & WithoutSignal<MonitorCreateOptions>

/** `Omit` for each member of a union, so the `agent`/`ttl` pairing holds. */
type WithoutSignal<T> = T extends unknown ? Omit<T, "signal"> : never

/** One monitor's answer in `monitors.createMany`. */
export type MonitorBatchResult = {
  /** The monitor's position in the array you passed. */
  index: number
  /** `201`: made. `200` with `replayed`: made before, under the same key. Any other
   *  status is this monitor's own error. */
  status: number
  monitor: Monitor | null
  replayed: boolean
  /** `{ code, message }`, and `param` when a field is at fault. */
  error: Json | null
  /** With a `429`: the seconds to wait before you send this monitor again. */
  retryAfter: number | null
  /** The key this monitor was sent with: send it again with the same key. */
  idempotencyKey: string
  raw: Json
}

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
  /** The monitor's new tags, in place of all its tags (the rule of `create`). `[]`
   *  removes them all; leave it out to keep them. */
  tags?: string[]
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
  /** Your labels for the monitor; empty when it has none. */
  tags: string[]
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
  /** The agent engine: `"v4"`, or `"engine"` for a monitor created with `inputs`. */
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
  /** The plan's `fetch_new_results`: whether the agent fetches each run's new search
   *  results, and at most how many pages a run. */
  fetchNewResults?: FetchNewResults
  /** The plan's `preset_strict`: whether the compile kept only the preset's fields and
   *  yours. */
  presetStrict?: boolean
  raw: Json
}

/** `AgentDocument.fetchNewResults`. */
export type FetchNewResults = { on: boolean; capPerRun: number }

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

/** The monitors of `monitors.changesAcross`: your key's own live monitors that carry
 *  `tag`, or the monitors of `ids`, one of the two. */
export type MonitorChangesAcrossScope =
  | {
      /** Your key's own live monitors that carry this tag. One with no agent is in `skipped`. */
      tag: string
      ids?: never
    }
  | {
      /** These monitors, at most 100: any monitor with an agent in your key's project, ended
       *  ones too. One that is not is a 404 for the whole read. */
      ids: string[]
      tag?: never
    }

/** Options for `monitors.changesAcross` and `monitors.iterateChangesAcross`. */
export type MonitorChangesAcrossOptions = {
  /** The `nextCursor` of the page before. If you leave it out, the read starts at the
   *  first change. Do not send it with `since`. */
  cursor?: string
  /** Read from this time on, as in `changes`. A monitor that joins later starts at the
   *  same time. Do not send it with `cursor`. */
  since?: string | Date
  /** Only these kinds of change, as in `changes`. */
  kinds?: string[]
  /** How many changes to return (server default 200, maximum 500). */
  limit?: number
  signal?: AbortSignal
}

/** One page of `monitors.changesAcross`. Ordered by `seq`, but a monitor that joins later
 *  or catches up can bring lower seqs on a later page: dedupe by `seq`. */
export type MonitorsChangesPage = {
  changes: ChangeRecord[]
  /** Keep this and pass it as `cursor` to read on. It is opaque, and holds the place of
   *  every monitor of the read, the `pending` ones too. */
  nextCursor: string
  /** `true` only for a full page: read on now with `nextCursor`. */
  more: boolean
  /** The monitors read for this page. */
  monitors: string[]
  /** The monitors not read on this call. A later call with `nextCursor` reads them. */
  pending: string[]
  /** The monitors of the tag that have no agent. */
  skipped: string[]
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
  /** Only your key's monitors that carry this one tag. Page on with `cursor` and the same `tag`. */
  tag?: string
  signal?: AbortSignal
}

/** One page of `monitors.listPage`. */
export type MonitorPage = {
  monitors: Monitor[]
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null
}

// --------------------------------------------------------------------------- //
// A monitor created with `inputs`: its onboarding, its expansions and its data map
// --------------------------------------------------------------------------- //

/** One example of an onboarding candidate: the name it was found under, the quote and
 *  its page. */
export type OnboardingExample = {
  name: string | null
  quote: string | null
  url: string | null
}

/** One candidate of a company's sheet: a kind of item or of event found on its pages. */
export type OnboardingCandidate = {
  /** Name it in the marks of `monitors.applyOnboarding`. */
  id: string
  /** `entity` (a kind of item) or `event` (a kind of event). */
  what: string | null
  /** As read on the pages: data, never instructions. */
  label: string
  /** The kind or category of the schema it is; `null` when it is new. */
  mappedTo: string | null
  isNew: boolean
  /** How many times it was found. */
  count: number
  /** On how many sites. */
  origins: number
  example: OnboardingExample | null
  raw: Json
}

/** What the first read of one company found: `OnboardingCompany.sheet`. */
export type CompanySheet = {
  companyId: string | null
  /** How many pages were read. */
  pages: number
  /** The most found first. */
  candidates: OnboardingCandidate[]
  note: string | null
  raw: Json
}

/** One company of `monitors.onboarding`, and its sheet once it is done. */
export type OnboardingCompany = {
  companyId: string
  /** `pending`, `running` (its pages are being read) or `done`. */
  status: string
  runId: string | null
  /** `null` until the company is `done`. */
  sheet: CompanySheet | null
  /** The marks the sheet was applied with, as the router sent them; `null` until then. */
  marks: Json | null
  /** When the sheet was made. */
  at: string | null
  /** When the sheet was applied; `null` until then. */
  appliedAt: string | null
  raw: Json
}

/** The onboarding sheets of a monitor's companies, one per company: `monitors.onboarding`. */
export type OnboardingSheet = {
  monitorId: string | null
  companies: OnboardingCompany[]
  raw: Json
}

/** Your review of one company's sheet: `monitors.applyOnboarding`. Every field but
 *  `signal` is sent, with the router's own names. */
export type OnboardingMarks = {
  /** The company whose sheet this is. */
  companyId: string
  /** The candidate ids to accept. */
  accept?: string[]
  /** New labels, by candidate id. */
  rename?: Record<string, string>
  /** Candidates to merge into another, by candidate id. */
  merge?: Record<string, string>
  /** The candidate ids to reject. */
  reject?: string[]
  signal?: AbortSignal
}

/** A change Telem accepted: the job that makes it. The answer to
 *  `monitors.applyOnboarding`, `confirmExpansion` and `revertExpansion`. */
export type ApplyResult = {
  jobId: string
  raw: Json
}

/** One thing a monitor proposed to add, or added: the records of `monitors.expansions`. */
export type ExpansionRecord = {
  /** Pass it to `confirmExpansion` or `revertExpansion`. */
  id: string
  /** Such as `entity`, `person`, `category`, `source` or `watch`. */
  kind: string
  /** What it adds: an item, a person, a category, a site or a page. */
  target: string
  /** `proposed`, `active`, `demoted`, `retired` or `reverted`. */
  status: string
  reason: Json
  delta: Json
  /** The counts behind the proposal. */
  counts: Json
  /** One line that says what it is and why. */
  note: string | null
  runId: string | null
  createdAt: string | null
  updatedAt: string | null
  raw: Json
}

/** One page of `monitors.expansions`. */
export type ExpansionsPage = {
  /** The newest first. */
  expansions: ExpansionRecord[]
  nextCursor: string | null
}

/** Options for `monitors.expansions`. */
export type MonitorExpansionsOptions = {
  /** Only the records with this status: `proposed`, `active`, `demoted`, `retired` or
   *  `reverted`. */
  status?: string
  signal?: AbortSignal
}

/** What `monitors.confirmExpansion` sends: for an added item, its `domain` or `handle`,
 *  if you know them. Every field but `signal` is sent. */
export type ExpansionConfirmFields = {
  domain?: string
  handle?: string
  signal?: AbortSignal
}

/** Options for `monitors.feedback`. */
export type MonitorFeedbackOptions = {
  /** The fact's id, as a change names it. */
  factId: string
  /** `confirmed` (it is right), `refuted` (it is wrong) or `restored` (a refuted fact
   *  counts again). */
  verdict: string
  /** With `refuted`, on a monitor created with `inputs`: the event category the fact
   *  belongs to instead, such as `other_notable`. */
  category?: string
  signal?: AbortSignal
}

/** The labelled fact's status now: `monitors.feedback`. */
export type FeedbackResult = {
  /** `verified`, `refuted` or `extracted`. */
  status: string
  /** The job that files the fact under `category`; `null` without one. */
  jobId: string | null
  raw: Json
}

/** Every kind and category a monitor collects: `monitors.dataMap`. The entries are the
 *  router's own objects, as it sent them. */
export type DataMap = {
  /** One per kind of item, such as `{ kind: "program", attributes: [...] }`. */
  kinds: Json[]
  /** The categories of events it collects. */
  categories: Json[]
  /** The categories it found in its own results and that wait for you to confirm them. */
  inducedCategories: Json[]
  /** How people are found: `discover`, and how many are `proposed` and `active`. */
  people: Json
  note: string | null
  raw: Json
}

/** One company of `monitors.companies`. */
export type CompanyListRow = {
  companyId: string
  name: string
  domain: string
  /** Whether the company is marked priority: it is checked on every routine run. */
  priority: boolean
  aliases: string[]
  ticker: string
  xHandle: string
  newsroomUrl: string
  teamPage: string
  /** `daily`, `weekly` or `off`, as you gave it; empty when its rank decides. */
  tier: string
  /** Its place among the monitor's companies, from 1. */
  rank: number
  raw: Json
}

/** One page of `monitors.companies`, in rank order. */
export type CompanyList = {
  /** All the companies the monitor follows. */
  total: number
  /** How many of them are marked priority. */
  priorityCount: number
  offset: number
  limit: number
  /** Pass it as `offset` for the next page; `null` on the last page. */
  nextOffset: number | null
  companies: CompanyListRow[]
  raw: Json
}

/** Options for `monitors.companies`. */
export type MonitorCompaniesOptions = {
  /** How many companies to skip, from the top (server default 0). */
  offset?: number
  /** How many companies to return (server default 100, maximum 1,000). */
  limit?: number
  signal?: AbortSignal
}

/** The `telem.monitors` namespace. */
export type MonitorsResource = {
  /** Create a monitor. It has the agent unless `agent` is `false`, and with the agent
   *  `ttl` is required: a create without it throws a `TelemError` (`invalid_request`)
   *  before anything is sent. */
  create(query: string, options: MonitorCreateOptions): Promise<Monitor>
  /** Create many monitors, ten per call, one call after another. One result per monitor,
   *  in the order given; a monitor that fails does not stop the others. Each call retries
   *  as `create` does, and after a 502 or 504 too, then only the monitors answered with a 429 (or a 409
   *  `idempotency_in_progress`) are sent again, with their keys, for up to about 120 s per
   *  call. A bad monitor, an unknown option, a monitor that is not JSON or a key given
   *  twice throws a `TelemError` (`invalid_request`) naming the index, before anything is
   *  sent. Once a call was sent, any failure (a call refused whole, an abort as `aborted`)
   *  throws with `results` (each monitor's last answer so far) and `idempotencyKeys` (every
   *  monitor's key) on the error, and its message says the monitors may exist. */
  createMany(items: MonitorCreateManyItem[], options?: { signal?: AbortSignal }): Promise<MonitorBatchResult[]>
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
  /** One page of the changes of up to 100 monitors, by `tag` or by `ids`. Keep `nextCursor`
   *  and pass it back as `cursor` with the same scope; read on now while `more` is true. */
  changesAcross(scope: MonitorChangesAcrossScope, options?: MonitorChangesAcrossOptions): Promise<MonitorsChangesPage>
  /** The changes of up to 100 monitors, page by page while `more` is true, in one pass. It
   *  cannot hand back the cursor: to keep your place, page with `changesAcross`. */
  iterateChangesAcross(
    scope: MonitorChangesAcrossScope,
    options?: MonitorChangesAcrossOptions,
  ): AsyncGenerator<ChangeRecord, void, undefined>
  /** Label one fact of the monitor. With `category`, a refuted fact of a monitor created
   *  with `inputs` is filed under that category. */
  feedback(monitorId: string, options: MonitorFeedbackOptions): Promise<FeedbackResult>
  /** The onboarding sheet of each company of a monitor created with `inputs`. */
  onboarding(monitorId: string, options?: { signal?: AbortSignal }): Promise<OnboardingSheet>
  /** Apply your review of one company's onboarding sheet. A 409 (`onboarding_pending`,
   *  `compile_in_progress`) or a 429 changed nothing. */
  applyOnboarding(monitorId: string, marks: OnboardingMarks): Promise<ApplyResult>
  /** What a monitor created with `inputs` proposes to add, or added, newest first. */
  expansions(monitorId: string, options?: MonitorExpansionsOptions): Promise<ExpansionsPage>
  /** Use a proposed addition: an item becomes active, a category joins the schema. */
  confirmExpansion(
    monitorId: string,
    expansionId: string,
    fields?: ExpansionConfirmFields,
  ): Promise<ApplyResult>
  /** Remove an addition: it is never proposed again, and the facts it brought are taken back. */
  revertExpansion(
    monitorId: string,
    expansionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApplyResult>
  /** Every kind and category the monitor collects, and how it finds people. */
  dataMap(monitorId: string, options?: { signal?: AbortSignal }): Promise<DataMap>
  /** One page of the companies a monitor created with `inputs` follows, in rank order. A
   *  monitor created without `inputs` answers 409 (`not_an_engine_monitor`), and one created
   *  with `agent: false` answers 404. */
  companies(monitorId: string, options?: MonitorCompaniesOptions): Promise<CompanyList>
}

/** One of the project's webhook endpoints. Its secret is shown only by `create` and `rotate`. */
export type WebhookEndpoint = {
  id: string
  url: string
  /** The monitor tags it takes deliveries for, any one of them; `[]` takes every monitor. */
  tags: string[]
  createdAt: string | null
  updatedAt: string | null
  raw: Json
}

/** The answer to `webhookEndpoints.create`: the endpoint and its secret, shown only here
 *  and on rotate. */
export type WebhookEndpointCreated = WebhookEndpoint & {
  /** `whsec_…`: check each delivery's `Telem-Signature` with it. */
  secret: string
}

/** The answer to `webhookEndpoints.rotate`: the new secret. The one it replaces still
 *  signs until `previousUntil`. */
export type WebhookEndpointRotated = {
  id: string
  secret: string
  previousUntil: string
  raw: Json
}

/** Options for `webhookEndpoints.create`. */
export type WebhookEndpointCreateOptions = {
  /** Monitor tags: the endpoint gets the deliveries of the project's monitors that carry
   *  any one of them. Leave it out, or send `[]`, for every monitor. */
  tags?: string[]
  signal?: AbortSignal
}

/** Options for `webhookEndpoints.update`. Send `url`, `tags` or both. */
export type WebhookEndpointUpdateOptions = {
  /** A new `https` URL. The secret stays. */
  url?: string
  /** The endpoint's new tags, in place of all of them. `[]` takes every monitor. */
  tags?: string[]
  signal?: AbortSignal
}

/** The `telem.webhookEndpoints` namespace. */
export type WebhookEndpointsResource = {
  /** Add an endpoint to the API key's project, at most 10: past that is 409
   *  (`too_many_endpoints`). Keep the `secret`: it is not shown again. */
  create(url: string, options?: WebhookEndpointCreateOptions): Promise<WebhookEndpointCreated>
  /** The project's endpoints, newest first, without their secrets. */
  list(options?: { signal?: AbortSignal }): Promise<WebhookEndpoint[]>
  /** One endpoint, without its secret. Another project's, or a deleted one, answers 404. */
  get(endpointId: string, options?: { signal?: AbortSignal }): Promise<WebhookEndpoint>
  /** Change the url, which keeps the secret, or replace the tags. */
  update(endpointId: string, options: WebhookEndpointUpdateOptions): Promise<WebhookEndpoint>
  delete(endpointId: string, options?: { signal?: AbortSignal }): Promise<void>
  /** A new secret. For 24 hours, until `previousUntil`, each delivery is signed with the new
   *  secret and the one it replaces; a second rotate within them drops the older. */
  rotate(endpointId: string, options?: { signal?: AbortSignal }): Promise<WebhookEndpointRotated>
}
