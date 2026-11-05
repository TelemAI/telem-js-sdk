// monitors: a query that Telem runs on a schedule, with an agent that keeps what
// matches. Python twin: telem/resources/monitors.py.
//
// A create has the agent unless `agent` is `false`, and a monitor with the agent must
// end, so its create needs a `ttl`: one without it is refused before anything is sent.
//
// The agent reads (`agent`, `changes`, `iterateChanges`) are GETs on
// `/v1/monitors/{id}/agent`. They change nothing, so they retry like any other GET.
// Like every other response here they are mapped to camelCase with the router's own
// object kept in `raw`; `before` and `after` of a change are the exception, passed
// through as the router sent them.
//
// `poll` is deprecated, and warns once per process. A poll answers with the search
// response shape, read by the search parser. It echoes no `normalized_schema_version`,
// so the search version gate does not run.
//
// A monitor created with `inputs` watches a list of companies: `onboarding` and
// `applyOnboarding`, `expansions` with `confirmExpansion` and `revertExpansion`, and
// `dataMap`. `feedback` labels a fact of any monitor with an agent. The reads retry like
// any GET; the writes queue a change, so they retry a 429 only, as a create does.

import type { ResolvedConfig } from "../config.ts"
import { TimeoutError } from "../errors.ts"
import { asArray, asObject, invalidRequest, isObject, request, type Payload } from "../http.ts"
import type {
  AgentDocument,
  AgentState,
  ApplyResult,
  ChangeRecord,
  ChangesPage,
  CompanySheet,
  DataMap,
  ExpansionRecord,
  ExpansionsPage,
  FeedbackResult,
  Monitor,
  MonitorChangesOptions,
  MonitorCreateCommonOptions,
  MonitorInputs,
  MonitorListOptions,
  MonitorPage,
  MonitorsResource,
  OnboardingCandidate,
  OnboardingCompany,
  OnboardingExample,
  OnboardingSheet,
} from "../types.ts"
import { buildSearchResponse, searchBlock } from "./search.ts"

/** Why a create with the agent and no `ttl` is refused before anything is sent. */
const NEEDS_TTL =
  'A monitor with an agent must end: pass ttl, such as ttl: "30d" (at most 30 days), ' +
  "or agent: false for a monitor without an agent."

/** The same, for a create with `inputs`. The router refuses `inputs` with `agent: false`
 *  (400); the SDK does not check that before it sends. */
const NEEDS_TTL_INPUTS = 'A monitor with inputs must end: pass ttl, such as ttl: "30d" (at most 365 days).'

/** What a create can be given at run time. The types ask for `ttl` with the agent, but a
 *  JavaScript caller can send anything, `null` included, or no options at all. */
type CreateInput = MonitorCreateCommonOptions & {
  ttl?: string | null
  agent?: boolean | null
  inputs?: MonitorInputs | null
}

const POLL_DEPRECATED =
  "@telemai/sdk: monitors.poll() is deprecated: read what the monitor agent finds with " +
  "monitors.iterateChanges() or monitors.changes()."

/** Whether this process has been told that `poll` is deprecated: it is told once. */
let pollWarned = false

function warnPollDeprecated(): void {
  if (pollWarned) return
  pollWarned = true
  console.warn(POLL_DEPRECATED)
}

/** Tests only: forget that this process was told `poll` is deprecated. The package
 *  does not export it. */
export function resetPollWarning(): void {
  pollWarned = false
}

function agentStateFrom(data: Payload): AgentState {
  return {
    engine: String(data.engine ?? ""),
    status: String(data.status ?? ""),
    needsAttention: data.needs_attention === true,
    planVersion: typeof data.plan_version === "number" ? data.plan_version : null,
    nextRunAt: typeof data.next_run_at === "string" ? data.next_run_at : null,
    watermark: Number(data.watermark ?? 0),
    // No compile job yet is null, not an object of empty strings.
    compile: isObject(data.compile)
      ? {
          jobId: String(data.compile.job_id ?? ""),
          status: String(data.compile.status ?? ""),
          error: typeof data.compile.error === "string" ? data.compile.error : null,
        }
      : null,
  }
}

function monitorFrom(body: unknown): Monitor {
  const data = asObject(body)
  const monitor: Monitor = {
    id: String(data.id ?? ""),
    query: data.query ?? "",
    frequency: data.frequency ?? "",
    status: String(data.status ?? ""),
    sessionId: String(data.session_id ?? ""),
    createdAt: data.created_at ?? "",
    lastPolledAt: data.last_polled_at ?? null,
    expiresAt: data.expires_at ?? null,
    webhookUrl: data.webhook_url ?? null,
    webhookSecret: data.webhook_secret ?? null,
    agentNote: typeof data.agent_note === "string" ? data.agent_note : null,
    raw: data,
  }
  // `null` is a monitor without an agent. A router that sends no `agent_state` at all
  // (one from before the agent reads) leaves it undefined: that is not "no agent".
  if (data.agent_state !== undefined) {
    monitor.agentState = isObject(data.agent_state) ? agentStateFrom(data.agent_state) : null
  }
  return monitor
}

/** Only the fields the document has: the SDK says nothing the router did not. */
function agentDocumentFrom(body: unknown): AgentDocument {
  const data = asObject(body)
  const document: AgentDocument = { raw: data }
  if (typeof data.status === "string") document.status = data.status
  if (typeof data.query === "string") document.query = data.query
  if (typeof data.frequency === "string") document.frequency = data.frequency
  if (typeof data.spec_version === "number") document.specVersion = data.spec_version
  if (data.budget !== undefined) document.budget = isObject(data.budget) ? data.budget : null
  if (typeof data.spend_usd === "number") document.spendUsd = data.spend_usd
  return document
}

function changeRecordFrom(entry: Payload): ChangeRecord {
  const subject = asObject(entry.subject)
  return {
    seq: Number(entry.seq ?? 0),
    type: String(entry.type ?? ""),
    kind: String(entry.kind ?? ""),
    monitorId: String(entry.monitor_id ?? ""),
    subject: {
      entityId: typeof subject.entity_id === "string" ? subject.entity_id : null,
      name: typeof subject.name === "string" ? subject.name : null,
    },
    // The values depend on the kind (an object, a status string, nothing): as sent.
    before: entry.before ?? null,
    after: entry.after ?? null,
    factIds: asArray(entry.fact_ids).map(String),
    at: String(entry.at ?? ""),
    raw: entry,
  }
}

function changesPageFrom(body: unknown): ChangesPage {
  const data = asObject(body)
  return {
    changes: asArray(data.changes).filter(isObject).map(changeRecordFrom),
    nextCursor: Number(data.next_cursor ?? 0),
    watermark: Number(data.watermark ?? 0),
  }
}

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null)

/** A count the router may send as the list it counts. */
const countOf = (value: unknown): number =>
  Array.isArray(value) ? value.length : typeof value === "number" ? value : 0

/** What the caller set, without `signal`: a field left `undefined` or `null` is not sent. */
function setFields(fields: Payload): Payload {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => key !== "signal" && value != null))
}

function exampleFrom(data: unknown): OnboardingExample | null {
  if (!isObject(data)) return null
  return { name: stringOrNull(data.name), quote: stringOrNull(data.quote), url: stringOrNull(data.url) }
}

function candidateFrom(entry: Payload): OnboardingCandidate {
  return {
    id: String(entry.id ?? ""),
    what: stringOrNull(entry.what),
    label: String(entry.label ?? ""),
    mappedTo: stringOrNull(entry.mapped_to),
    isNew: entry.is_new === true,
    count: countOf(entry.count),
    origins: countOf(entry.origins),
    example: exampleFrom(entry.example),
    raw: entry,
  }
}

function companySheetFrom(data: Payload): CompanySheet {
  return {
    companyId: stringOrNull(data.company_id),
    pages: countOf(data.pages),
    candidates: asArray(data.candidates).filter(isObject).map(candidateFrom),
    note: stringOrNull(data.note),
    raw: data,
  }
}

function onboardingCompanyFrom(entry: Payload): OnboardingCompany {
  return {
    companyId: String(entry.company_id ?? ""),
    status: String(entry.status ?? ""),
    runId: stringOrNull(entry.run_id),
    sheet: isObject(entry.sheet) ? companySheetFrom(entry.sheet) : null,
    marks: isObject(entry.marks) ? entry.marks : null,
    at: stringOrNull(entry.at),
    appliedAt: stringOrNull(entry.applied_at),
    raw: entry,
  }
}

function onboardingSheetFrom(body: unknown): OnboardingSheet {
  const data = asObject(body)
  return {
    monitorId: stringOrNull(data.monitor_id),
    companies: asArray(data.companies).filter(isObject).map(onboardingCompanyFrom),
    raw: data,
  }
}

function applyResultFrom(body: unknown): ApplyResult {
  const data = asObject(body)
  return { jobId: String(data.job_id ?? ""), raw: data }
}

function expansionFrom(entry: Payload): ExpansionRecord {
  return {
    id: String(entry.id ?? ""),
    kind: String(entry.kind ?? ""),
    target: String(entry.target ?? ""),
    status: String(entry.status ?? ""),
    reason: asObject(entry.reason),
    delta: asObject(entry.delta),
    counts: asObject(entry.counts),
    note: stringOrNull(entry.note),
    runId: stringOrNull(entry.run_id),
    createdAt: stringOrNull(entry.created_at),
    updatedAt: stringOrNull(entry.updated_at),
    raw: entry,
  }
}

function expansionsPageFrom(body: unknown): ExpansionsPage {
  const data = asObject(body)
  return {
    expansions: asArray(data.expansions).filter(isObject).map(expansionFrom),
    nextCursor: stringOrNull(data.next_cursor),
  }
}

function feedbackResultFrom(body: unknown): FeedbackResult {
  const data = asObject(body)
  return { status: String(data.status ?? ""), jobId: stringOrNull(data.job_id), raw: data }
}

function dataMapFrom(body: unknown): DataMap {
  const data = asObject(body)
  return {
    // A kind named bare, as a monitor created without inputs may have it.
    kinds: asArray(data.kinds)
      .map((kind) => (typeof kind === "string" ? { kind } : kind))
      .filter(isObject),
    categories: asArray(data.categories).filter(isObject),
    inducedCategories: asArray(data.induced_categories).filter(isObject),
    people: asObject(data.people),
    note: stringOrNull(data.note),
    raw: data,
  }
}

function listQuery(options: MonitorListOptions): string {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set("limit", String(options.limit))
  if (options.cursor !== undefined) params.set("cursor", options.cursor)
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** A `Date` goes out in UTC; a string goes out as given, and the router refuses a time
 *  without an offset. The string is told by its type: a `Date` made in another realm (a
 *  vm context, an iframe) is not `instanceof Date` here, and must not go out as text. */
function sinceParam(since: string | Date): string {
  if (typeof since === "string") return since
  if (Number.isNaN(since.getTime())) throw invalidRequest("since is not a valid date")
  return since.toISOString()
}

/** Only what the caller set is sent: `0` is a value, and the router has its own defaults.
 *  `URLSearchParams` encodes the "+" of an offset, which a router would read as a space. */
function changesQuery(options: MonitorChangesOptions): string {
  const params = new URLSearchParams()
  if (options.cursor !== undefined) params.set("cursor", String(options.cursor))
  if (options.since !== undefined) params.set("since", sinceParam(options.since))
  if (options.kinds !== undefined) params.set("kinds", options.kinds.join(","))
  if (options.limit !== undefined) params.set("limit", String(options.limit))
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Bind the monitors resource to one client's configuration. */
export function createMonitors(config: ResolvedConfig): MonitorsResource {
  // Encoded, and all-dots ids refused, for the same reason as the sessions path.
  const path = (monitorId: string, suffix = "") => {
    if (!monitorId || /^\.+$/.test(monitorId)) throw invalidRequest("a monitor id is required")
    return `/v1/monitors/${encodeURIComponent(monitorId)}${suffix}`
  }

  /** One page of your monitors, newest first, and the cursor of the next page. */
  const listPage = async (options: MonitorListOptions = {}): Promise<MonitorPage> => {
    const route = `/v1/monitors${listQuery(options)}`
    const data = asObject(await request(config, "GET", route, undefined, options.signal))
    const nextCursor = typeof data.next_cursor === "string" ? data.next_cursor : null
    return { monitors: asArray(data.monitors).map(monitorFrom), nextCursor }
  }

  /** One page of the agent's changes: the records after the cursor, up to the watermark. */
  const changes = async (monitorId: string, options: MonitorChangesOptions = {}): Promise<ChangesPage> => {
    const route = `${path(monitorId, "/agent/changes")}${changesQuery(options)}`
    return changesPageFrom(await request(config, "GET", route, undefined, options.signal))
  }

  /** `…/agent/expansions/{id}:confirm` or `:revert`, the id one encoded path segment. */
  const expansionPath = (monitorId: string, expansionId: string, action: "confirm" | "revert") => {
    if (!expansionId || /^\.+$/.test(expansionId)) throw invalidRequest("an expansion id is required")
    return path(monitorId, `/agent/expansions/${encodeURIComponent(expansionId)}:${action}`)
  }

  /** A write that queues a change: like a create, only a 429 is sent again. */
  const write = async (route: string, body: Payload, signal?: AbortSignal): Promise<unknown> =>
    request(config, "POST", route, body, signal, "rate_limit")

  return {
    /** Create a monitor. Telem runs `query` on the schedule, and its agent keeps what matches. */
    async create(query, options) {
      const given: CreateInput = options ?? {}
      // A missing or null agent is the default: on.
      const agent = given.agent == null ? true : Boolean(given.agent)
      if (agent && !given.ttl) throw invalidRequest(given.inputs == null ? NEEDS_TTL : NEEDS_TTL_INPUTS)
      const monitorOptions: Payload = {}
      if (given.frequency !== undefined) monitorOptions.frequency = given.frequency
      if (given.includeDomains !== undefined) {
        monitorOptions.include_domains = given.includeDomains
      }
      if (given.search !== undefined) monitorOptions.search = searchBlock({}, given.search)
      const body: Payload = { query, options: monitorOptions }
      if (given.metadata !== undefined) body.metadata = given.metadata
      if (given.webhookUrl !== undefined) body.webhook_url = given.webhookUrl
      if (given.ttl !== undefined) body.ttl = given.ttl
      // Sent as given: the router checks the companies and the schema.
      if (given.inputs != null) body.inputs = given.inputs
      body.agent = agent
      // A retry after a lost reply would create a second, billed monitor. Only a 429
      // is safe: the router created nothing then.
      const data = await request(config, "POST", "/v1/monitors", body, given.signal, "rate_limit").catch(
        (error: unknown) => {
          // The router may have made the monitor before the client gave up.
          if (error instanceof TimeoutError) {
            throw new TimeoutError(
              `${error.message}. The monitor may exist: list monitors before you create it again.`,
              error.cause,
            )
          }
          throw error
        },
      )
      return monitorFrom(data)
    },

    /** List your monitors, newest first. `listPage` also gives the next cursor. */
    async list(options = {}) {
      return (await listPage(options)).monitors
    },

    listPage,

    /** Get one monitor. */
    async get(monitorId, options = {}) {
      return monitorFrom(await request(config, "GET", path(monitorId), undefined, options.signal))
    },

    /** Pause, resume, renew or change a monitor. Only the fields given are sent. */
    async update(monitorId, options) {
      const body: Payload = {}
      if (options.status !== undefined) body.status = options.status
      if (options.frequency !== undefined) body.frequency = options.frequency
      if (options.ttl !== undefined) body.ttl = options.ttl
      // "" removes the webhook, as `null` does and as in the Python SDK.
      if (options.webhookUrl !== undefined) body.webhook_url = options.webhookUrl || null
      const route = path(monitorId)
      return monitorFrom(await request(config, "PATCH", route, body, options.signal))
    },

    /** Get the monitor's own results that are new since the last poll. Deprecated: it
     *  warns once per process. */
    async poll(monitorId, options = {}) {
      warnPollDeprecated()
      const body: Payload = {}
      if (options.session !== undefined) body.session_id = options.session
      if (options.metadata !== undefined) body.metadata = options.metadata
      const route = path(monitorId, "/poll")
      // A poll moves the monitor past the results it returns, so a retry after a lost
      // reply would return nothing new. Only a 429 is safe: no provider was read then.
      const data = await request(config, "POST", route, body, options.signal, "rate_limit")
      return buildSearchResponse(data)
    },

    /** Delete a monitor. A repeat deletes what a failed delete left. */
    async delete(monitorId, options = {}) {
      await request(config, "DELETE", path(monitorId), undefined, options.signal)
    },

    /** Read the monitor agent's document. A monitor without an agent answers 404. */
    async agent(monitorId, options = {}) {
      const route = path(monitorId, "/agent")
      return agentDocumentFrom(await request(config, "GET", route, undefined, options.signal))
    },

    /** One page of the agent's changes. Keep `nextCursor` and pass it back as `cursor`. */
    changes,

    /** Every change after `cursor`, page by page, until you are caught up. */
    async *iterateChanges(monitorId, options = {}) {
      let cursor = options.cursor ?? 0
      for (;;) {
        const page = await changes(monitorId, { cursor, signal: options.signal })
        for (const change of page.changes) yield change
        // Caught up: the cursor reached the watermark. An empty page ends the walk too, and
        // so does a cursor that did not move: a router that stalls cannot hold this loop
        // on the same page for ever.
        if (!page.changes.length || page.nextCursor <= cursor || page.nextCursor >= page.watermark) return
        cursor = page.nextCursor
      }
    },

    /** Label one fact of the monitor; with `category`, file a refuted fact there. */
    async feedback(monitorId, options) {
      const body: Payload = { fact_id: options.factId, verdict: options.verdict }
      if (options.category != null) body.category = options.category
      return feedbackResultFrom(await write(path(monitorId, "/agent/feedback"), body, options.signal))
    },

    /** The onboarding sheet of each company of a monitor created with `inputs`. */
    async onboarding(monitorId, options = {}) {
      const route = path(monitorId, "/agent/onboarding")
      return onboardingSheetFrom(await request(config, "GET", route, undefined, options.signal))
    },

    /** Apply your review of one company's sheet: `companyId` goes as `company_id`. */
    async applyOnboarding(monitorId, marks) {
      const { companyId, ...rest } = marks
      const body = setFields({ company_id: companyId, ...rest })
      return applyResultFrom(await write(path(monitorId, "/agent/onboarding:apply"), body, marks.signal))
    },

    /** What the monitor proposes to add, or added; `status` filters. */
    async expansions(monitorId, options = {}) {
      const query = options.status !== undefined ? `?${new URLSearchParams({ status: options.status })}` : ""
      const route = `${path(monitorId, "/agent/expansions")}${query}`
      return expansionsPageFrom(await request(config, "GET", route, undefined, options.signal))
    },

    /** Use a proposed addition. */
    async confirmExpansion(monitorId, expansionId, fields = {}) {
      const route = expansionPath(monitorId, expansionId, "confirm")
      return applyResultFrom(await write(route, setFields(fields), fields.signal))
    },

    /** Remove an addition. */
    async revertExpansion(monitorId, expansionId, options = {}) {
      const route = expansionPath(monitorId, expansionId, "revert")
      return applyResultFrom(await write(route, {}, options.signal))
    },

    /** Every kind and category the monitor collects. */
    async dataMap(monitorId, options = {}) {
      const route = path(monitorId, "/agent/data-map")
      return dataMapFrom(await request(config, "GET", route, undefined, options.signal))
    },
  }
}

/**
 * Check a monitor webhook: the `Telem-Signature` header against the raw body.
 * True when the signature is correct and not older than `toleranceSeconds`.
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  header: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]),
  )
  const t = parts.t ?? ""
  const v1 = parts.v1 ?? ""
  if (!/^\d+$/.test(t) || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false
  if (!/^([0-9a-f]{2})+$/.test(v1)) return false
  const encoder = new TextEncoder()
  const raw = typeof body === "string" ? encoder.encode(body) : body
  const signed = new Uint8Array([...encoder.encode(`${t}.`), ...raw])
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ])
  const signature = new Uint8Array(v1.match(/../g)!.map((byte) => parseInt(byte, 16)))
  // `verify` compares in constant time.
  return crypto.subtle.verify("HMAC", key, signature, signed)
}
