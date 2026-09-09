// search: the request body, the two composition rules, the V2 version gate, and the
// envelope reader. Python twins: BaseClient._search_body / _resolve_search_options /
// _check_search_contract (telem/_base.py) and telem/_normalize.py.
//
// Under the V2 contract each run's `output_payload` IS the server's normalized
// envelope, so nothing is normalized client-side: the envelope is read, not rebuilt.
// Provenance is fixed — query / batch_index / latency_ms /
// preprocessor_run_id / raw come from the RUN ROW, the query-level blocks come from
// the envelope interior, and result rows land verbatim.

import type { ResolvedConfig } from "../config.ts"
import { TelemError } from "../errors.ts"
import { asArray, asObject, invalidRequest, isObject, request, stringList, type Payload } from "../http.ts"
import { wireMetadata } from "../trajectory.ts"
import type {
  ProviderRun,
  SearchDefaults,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "../types.ts"

/** The lowest `normalized_schema_version` this SDK can parse. The whole
 *  response surface is the V2 envelope, so an older echo is a hard stop. */
const MIN_SCHEMA_VERSION = 2

/**
 * Resolve call options against the client defaults into the wire `search` block.
 *
 * Each option is the call argument when set, else the client default (constructor
 * option or env var), else unset. Two composition rules mirror the server's semantics:
 *
 * 1. A resolved `fields` replaces `tier` — the level that set it wins, and when both
 *    come from the same level `fields` wins. The block never carries both.
 * 2. When both provider halves resolve, `include` fully determines the set: the
 *    excluded names are subtracted here and `exclude` is not sent. An include emptied
 *    by that subtraction is still sent, as `[]`, so the server's own 400 fires.
 */
function searchBlock(defaults: SearchDefaults, options: SearchOptions): Payload {
  const fromCallTier = options.tier !== undefined
  const fromCallFields = options.fields !== undefined
  let tier = fromCallTier ? options.tier : defaults.tier
  let fields = fromCallFields ? options.fields : defaults.fields
  if (tier !== undefined && fields !== undefined) {
    if (fromCallTier && !fromCallFields) fields = undefined
    else tier = undefined
  }

  let include = options.providersInclude ?? defaults.providersInclude
  let exclude = options.providersExclude ?? defaults.providersExclude
  if (include !== undefined && exclude !== undefined) {
    const excluded = new Set(exclude)
    include = include.filter((name) => !excluded.has(name))
    exclude = undefined
  }

  const includeFullContent = options.includeFullContent ?? defaults.includeFullContent

  const providers: Payload = {}
  if (include !== undefined) providers.include = include
  if (exclude !== undefined) providers.exclude = exclude

  const block: Payload = {}
  if (tier !== undefined) block.tier = tier
  if (fields !== undefined) block.fields = fields
  if (Object.keys(providers).length) block.providers = providers
  if (options.providerOverrides !== undefined) block.provider_overrides = options.providerOverrides
  if (options.numResults !== undefined) block.num_results = options.numResults
  if (options.includeRaw !== undefined) block.include_raw = options.includeRaw
  if (options.rerank !== undefined) block.rerank = options.rerank
  if (includeFullContent !== undefined) block.include_full_content = includeFullContent
  return block
}

/** `user_input` for one query or a batch. A batch runs as ONE interaction and the
 *  backend tags each run with `batch_index`/`query`; a one-element batch collapses to
 *  the plain-string body. */
function userInput(query: string | string[]): Payload | Payload[] {
  if (typeof query === "string") {
    if (query === "") throw invalidRequest("search() requires a non-empty query")
    return { query }
  }
  const queries = stringList(query, "search() requires at least one query", "search() queries")
  if (queries.length === 1) return { query: queries[0] as string }
  return queries.map((item) => ({ query: item }))
}

/** The JSON body for `POST /v1/interactions`.
 *  `preprocessor_names` is never sent — under V2 it is a 400, provider selection is
 *  `search.providers`. `goal`/`context` merge into `metadata` only when given as
 *  arguments, so caller metadata keys are never overwritten otherwise; lineage and
 *  the session id follow `wireMetadata`. */
function searchBody(
  config: ResolvedConfig,
  query: string | string[],
  options: SearchOptions,
): Payload {
  const { metadata, sessionId } = wireMetadata(options, "search")
  if (options.goal !== undefined) metadata.goal = options.goal
  if (options.context !== undefined) metadata.context = options.context

  const body: Payload = {
    user_input: userInput(query),
    postprocessor_names: [],
    metadata,
  }
  const block = searchBlock(config.defaults, options)
  if (Object.keys(block).length) body.search = block
  if (sessionId !== undefined) body.session_id = sessionId
  return body
}

/** Verify a search response is V2-normalized before it is parsed.
 *  Search POSTs only: GETs carry no echo, and fetch echoes `null`. Callers branch on
 *  the code; the observed value is what makes the message diagnosable. */
function assertV2(data: unknown): void {
  let observed: string
  if (isObject(data)) {
    const version = data.normalized_schema_version
    if (typeof version === "number" && Number.isInteger(version) && version >= MIN_SCHEMA_VERSION) {
      return
    }
    observed = version === undefined ? "undefined" : JSON.stringify(version)
  } else {
    observed = Array.isArray(data) ? "array" : data === null ? "null" : typeof data
  }
  throw new TelemError(
    `server echoed normalized_schema_version=${observed}; expected >= ${MIN_SCHEMA_VERSION} — ` +
      "the server pre-dates the V2 normalized contract, or is a dev deployment with no " +
      "adapter-backed search providers configured; point the SDK at a provider-configured " +
      "V2 deployment",
    { code: "unsupported_server_version" },
  )
}

/** Read the envelope's rows. Each lands verbatim with three overrides: `url`/`title`
 *  are coerced from null (and from "") to "" — the server emits `title: null`
 *  routinely — `provider` is the run's own name, and `raw` is the row itself. The
 *  run's provenance is written LAST, so a row key named like a run key cannot win. */
function searchResults(envelope: Payload, provider: string): SearchResult[] {
  return asArray(envelope.results).filter(isObject).map((row) => ({
    url: row.url || "",
    title: row.title || "",
    summary: row.summary ?? null,
    excerpt: row.excerpt ?? null,
    fullContent: row.full_content ?? null,
    publishDate: row.publish_date ?? null,
    rank: row.rank ?? null,
    thumbnail: row.thumbnail ?? null,
    favicon: row.favicon ?? null,
    source: row.source ?? null,
    enrichments: row.enrichments ?? null,
    fetchMeta: row.fetch_meta ?? null,
    provider,
    raw: row,
  }))
}

/** One `preprocessor_runs` entry. Four shape malformations degrade instead of raising,
 *  so one bad provider cannot cost the caller the rest of a healthy response: a
 *  non-object run, a missing or non-object envelope, and a non-array `results` each
 *  yield an empty run, and a non-object result row is skipped. */
function providerRun(run: unknown): ProviderRun {
  const row = asObject(run)
  const envelope = asObject(row.output_payload)
  const provider: string = row.preprocessor_name ?? ""
  return {
    // -- from the run row --
    provider,
    status: row.status ?? "",
    error: row.error ?? null,
    latencyMs: row.latency_ms ?? null,
    preprocessorRunId: row.id ? String(row.id) : null,
    query: row.query ?? "",
    batchIndex: row.batch_index ?? 0,
    raw: row.raw_payload ?? null,
    // -- from the envelope interior --
    results: searchResults(envelope, provider),
    tier: envelope.tier ?? null,
    fields: asArray(envelope.fields),
    answer: envelope.answer ?? null,
    entities: envelope.entities ?? null,
    related: envelope.related ?? null,
    verticals: envelope.verticals ?? null,
    usage: envelope.usage ?? null,
    warnings: asArray(envelope.warnings),
  }
}

/** Build a `SearchResponse` from a parsed `POST /v1/interactions` body. The flattened
 *  `results` list is the in-order concatenation of every provider's rows: providers in
 *  run order, rows in envelope order. */
function buildSearchResponse(interaction: unknown): SearchResponse {
  const body = asObject(interaction)
  const byProvider = asArray(body.preprocessor_runs).map(providerRun)
  return {
    results: byProvider.flatMap((run) => run.results),
    byProvider,
    sessionId: String(body.session_id ?? ""),
    interactionId: String(body.interaction_id ?? ""),
    status: body.status ?? "",
    normalizedSchemaVersion: body.normalized_schema_version ?? null,
    raw: body,
  }
}

/**
 * Run a web search.
 *
 * @param config - The client's resolved configuration.
 * @param query - One query, or an array of queries batched into one interaction.
 * @param options - Per-call search options; each overrides the client default.
 * @returns The flattened results plus the per-provider breakdown.
 * @throws TelemError with code `invalid_request` when `query` is empty or not strings.
 * @throws TelemError with code `unsupported_server_version` when the server does not
 *         echo `normalized_schema_version >= 2`.
 */
export async function search(
  config: ResolvedConfig,
  query: string | string[],
  options: SearchOptions,
): Promise<SearchResponse> {
  const body = searchBody(config, query, options)
  const data = await request(config, "POST", "/v1/interactions", body, options.signal)
  assertV2(data)
  return buildSearchResponse(data)
}
