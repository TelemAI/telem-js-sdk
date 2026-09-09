// providers: the V2 provider catalog from `GET /v1/preprocessors`.
//
// A GET carries no version echo, so the search gate never runs here. A pre-V2 entry
// (no `normalized`, no `tiers`) reads as the conservative default rather than an
// error: an older deployment still answers, it just advertises less.

import type { ResolvedConfig } from "../config.ts"
import { asArray, asObject, isObject, request, type Payload } from "../http.ts"
import type { ProviderInfo } from "../types.ts"

/**
 * List the search providers this deployment can run.
 *
 * @param config - The client's resolved configuration.
 * @returns One entry per configured provider, in the server's own order.
 */
export async function providers(config: ResolvedConfig): Promise<ProviderInfo[]> {
  const body = await request(config, "GET", "/v1/preprocessors")
  return asArray(asObject(body).preprocessors).filter(isObject).map((entry: Payload) => ({
    name: entry.name ?? "",
    type: entry.type ?? "",
    activeByDefault: entry.active_by_default ?? false,
    description: entry.description ?? null,
    method: entry.method ?? null,
    url: entry.url ?? null,
    normalized: entry.normalized ?? false,
    tiers: asArray(entry.tiers),
  }))
}
