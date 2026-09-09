// fetch: the request body and the response reader for `POST /v1/fetch`. Python
// twins: BaseClient._fetch_body (telem/_base.py) and build_fetch_response
// (telem/_normalize.py).
//
// There is NO version gate here: fetch responses echo `normalized_schema_version:
// null`, and the key may be absent entirely. Neither shape may raise.

import type { ResolvedConfig } from "../config.ts"
import { asArray, asObject, isObject, request, stringList, type Payload } from "../http.ts"
import { wireMetadata } from "../trajectory.ts"
import type { FetchOptions, FetchResponse, FetchResult } from "../types.ts"

/** The JSON body for `POST /v1/fetch`. The endpoint's request model is
 *  `extra="forbid"`: it gets the top-level `urls` list plus an optional typed
 *  `options` block, and no `max_urls` knob — the server cap is the cap. URLs are not
 *  pre-validated beyond shape: a non-http(s) item and an over-cap batch are the
 *  server's 400s. Lineage and the session id follow `wireMetadata`. */
function fetchBody(url: string | string[], options: FetchOptions): Payload {
  // A bare string is ONE url, never a batch of characters.
  const urls = stringList(
    typeof url === "string" ? [url] : url,
    "fetch() requires at least one URL",
    "fetch() urls",
  )
  const { metadata, sessionId } = wireMetadata(options, "fetch")
  const body: Payload = { urls, metadata }
  const block: Payload = {}
  if (options.providers !== undefined) block.providers = options.providers
  if (options.inlineContent !== undefined) block.inline_content = options.inlineContent
  if (options.inlineMaxChars !== undefined) block.inline_max_chars = options.inlineMaxChars
  if (options.contentFormat !== undefined) block.content_format = options.contentFormat
  if (Object.keys(block).length) body.options = block
  if (sessionId !== undefined) body.session_id = sessionId
  return body
}

/** One `web_fetch` run. The engine emits one per URL with a single `fetched_results`
 *  row; the row's keys land verbatim. `url`/`status`/`error`/`latencyMs` fall back to
 *  the RUN ROW (whose `query` is the requested URL) so a run that failed before
 *  producing a row still yields a result for its URL.
 *
 *  The fallbacks are `||`, not `??`, and that is load-bearing: a row that came back
 *  with `url: ""` must still carry the URL that was asked for, and an empty row status
 *  must fall through to the run's. With `??` both would survive as "" and the caller
 *  would get a result it cannot match back to anything it requested. */
function fetchResult(run: Payload): FetchResult {
  const row = asObject(asArray(asObject(run.output_payload).fetched_results)[0])
  return {
    url: row.url || run.query || "",
    canonicalUrl: row.canonical_url ?? null,
    title: row.title || "",
    status: row.status || run.status || "",
    content: row.content ?? null,
    contentTruncated: row.content_truncated ?? null,
    contentFormat: row.content_format ?? null,
    contentSha256: row.content_sha256 ?? null,
    contentType: row.content_type ?? null,
    contentRef: row.content_ref ?? null,
    provider: row.provider || "",
    httpStatus: row.http_status ?? null,
    fetchedAt: row.fetched_at ?? null,
    // Key presence, not truthiness: a row that really reported 0 ms keeps its 0.
    latencyMs: ("latency_ms" in row ? row.latency_ms : run.latency_ms) ?? null,
    providerMetadata: row.provider_metadata ?? null,
    error: row.error || run.error || null,
    batchIndex: run.batch_index ?? 0,
    raw: row,
  }
}

/** Build a `FetchResponse`: one result per `web_fetch` run, ordered by `batch_index`,
 *  which is the request's own URL order. */
function buildFetchResponse(interaction: unknown): FetchResponse {
  const body = asObject(interaction)
  const runs = asArray(body.preprocessor_runs)
    .filter((run): run is Payload => isObject(run) && run.preprocessor_name === "web_fetch")
    .sort((left, right) => (left.batch_index || 0) - (right.batch_index || 0))
  return {
    results: runs.map(fetchResult),
    sessionId: String(body.session_id ?? ""),
    interactionId: String(body.interaction_id ?? ""),
    status: body.status ?? "",
    raw: body,
  }
}

/**
 * Fetch the readable content of one or more URLs.
 *
 * @param config - The client's resolved configuration.
 * @param url - One URL, or an array of URLs fetched in one request.
 * @param options - Per-call fetch options.
 * @returns One result per requested URL, in request order.
 * @throws TelemError with code `invalid_request` when `url` is empty or not strings.
 */
export async function fetchUrls(
  config: ResolvedConfig,
  url: string | string[],
  options: FetchOptions,
): Promise<FetchResponse> {
  const body = fetchBody(url, options)
  return buildFetchResponse(await request(config, "POST", "/v1/fetch", body, options.signal))
}
