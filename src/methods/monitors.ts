// monitors: a query that Telem runs on a schedule, read back with `poll`.
// Python twin: telem/resources/monitors.py.
//
// A poll answers with the search response shape, read by the search parser. It
// echoes no `normalized_schema_version`, so the search version gate does not run.

import type { ResolvedConfig } from "../config.ts"
import { asArray, asObject, invalidRequest, request, type Payload } from "../http.ts"
import type { Monitor, MonitorsResource } from "../types.ts"
import { buildSearchResponse } from "./search.ts"

function monitorFrom(body: unknown): Monitor {
  const data = asObject(body)
  return {
    id: String(data.id ?? ""),
    query: data.query ?? "",
    frequency: data.frequency ?? "",
    status: String(data.status ?? ""),
    sessionId: String(data.session_id ?? ""),
    createdAt: data.created_at ?? "",
    lastPolledAt: data.last_polled_at ?? null,
    webhookUrl: data.webhook_url ?? null,
    webhookSecret: data.webhook_secret ?? null,
    raw: data,
  }
}

/** Bind the monitors resource to one client's configuration. */
export function createMonitors(config: ResolvedConfig): MonitorsResource {
  // Encoded, and all-dots ids refused, for the same reason as the sessions path.
  const path = (monitorId: string, suffix = "") => {
    if (!monitorId || /^\.+$/.test(monitorId)) throw invalidRequest("a monitor id is required")
    return `/v1/monitors/${encodeURIComponent(monitorId)}${suffix}`
  }

  return {
    /** Create a monitor. Telem runs `query` on the schedule. */
    async create(query, options) {
      const body: Payload = { query, options: { frequency: options.frequency } }
      if (options.metadata !== undefined) body.metadata = options.metadata
      if (options.webhookUrl !== undefined) body.webhook_url = options.webhookUrl
      // A retry after a lost reply would create a second, billed monitor. Only a 429
      // is safe: the router created nothing then.
      const data = await request(config, "POST", "/v1/monitors", body, options.signal, "rate_limit")
      return monitorFrom(data)
    },

    /** List your monitors, newest first (server default 50, maximum 200). */
    async list(options = {}) {
      const query = options.limit === undefined ? "" : `?limit=${options.limit}`
      const body = await request(config, "GET", `/v1/monitors${query}`, undefined, options.signal)
      return asArray(asObject(body).monitors).map(monitorFrom)
    },

    /** Get one monitor. */
    async get(monitorId, options = {}) {
      return monitorFrom(await request(config, "GET", path(monitorId), undefined, options.signal))
    },

    /** Pause, resume or change a monitor. Only the fields given are sent. */
    async update(monitorId, options) {
      const body: Payload = {}
      if (options.status !== undefined) body.status = options.status
      if (options.frequency !== undefined) body.frequency = options.frequency
      if (options.webhookUrl !== undefined) body.webhook_url = options.webhookUrl
      const route = path(monitorId)
      return monitorFrom(await request(config, "PATCH", route, body, options.signal))
    },

    /** Get the results that are new since the last poll, one entry per provider. */
    async poll(monitorId, options = {}) {
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
