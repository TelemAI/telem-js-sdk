// webhookEndpoints: a project's URLs that get the webhook deliveries of many monitors,
// all of them or those with one of the endpoint's tags. Python twin:
// telem/resources/webhook_endpoints.py.
//
// The secret is shown only by `create` and `rotate`. Those two and `delete` retry a 429
// only: a second create makes a second endpoint, a second rotate drops the secret the
// first one kept, and a second delete answers 404. Node's inspect (console.log) prints
// their answers with the secret redacted; JSON keeps it.

import type { ResolvedConfig } from "../config.ts"
import { asArray, asObject, invalidRequest, isObject, request, type Payload } from "../http.ts"
import type {
  WebhookEndpoint,
  WebhookEndpointCreated,
  WebhookEndpointRotated,
  WebhookEndpointsResource,
} from "../types.ts"

const ROOT = "/v1/webhook-endpoints"
const INSPECT = Symbol.for("nodejs.util.inspect.custom")
const REDACTED = "[redacted]"

function redacted<T extends { secret: string; raw: Payload }>(value: T): T {
  Object.defineProperty(value, INSPECT, {
    value: () => ({ ...value, secret: REDACTED, raw: { ...value.raw, secret: REDACTED } }),
  })
  return value
}

function endpointFrom(body: unknown): WebhookEndpoint {
  const data = asObject(body)
  return {
    id: String(data.id ?? ""),
    url: String(data.url ?? ""),
    tags: asArray(data.tags).map(String),
    createdAt: typeof data.created_at === "string" ? data.created_at : null,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
    raw: data,
  }
}

function createdFrom(body: unknown): WebhookEndpointCreated {
  return redacted({ ...endpointFrom(body), secret: String(asObject(body).secret ?? "") })
}

function rotatedFrom(body: unknown): WebhookEndpointRotated {
  const data = asObject(body)
  return redacted({
    id: String(data.id ?? ""),
    secret: String(data.secret ?? ""),
    previousUntil: String(data.previous_until ?? ""),
    raw: data,
  })
}

/** Bind the webhook endpoints resource to one client's configuration. */
export function createWebhookEndpoints(config: ResolvedConfig): WebhookEndpointsResource {
  const path = (endpointId: string, suffix = "") => {
    if (!endpointId || /^\.+$/.test(endpointId)) throw invalidRequest("a webhook endpoint id is required")
    return `${ROOT}/${encodeURIComponent(endpointId)}${suffix}`
  }

  return {
    async create(url, options = {}) {
      const body: Payload = { url }
      if (options.tags != null) body.tags = options.tags
      return createdFrom(await request(config, "POST", ROOT, body, options.signal, "rate_limit"))
    },

    async list(options = {}) {
      const data = asObject(await request(config, "GET", ROOT, undefined, options.signal))
      return asArray(data.endpoints).filter(isObject).map(endpointFrom)
    },

    async get(endpointId, options = {}) {
      return endpointFrom(await request(config, "GET", path(endpointId), undefined, options.signal))
    },

    async update(endpointId, options = {}) {
      // The router refuses a null url or tags, so an unset field is not sent.
      const body: Payload = {}
      if (options.url != null) body.url = options.url
      if (options.tags != null) body.tags = options.tags
      return endpointFrom(await request(config, "PATCH", path(endpointId), body, options.signal))
    },

    async delete(endpointId, options = {}) {
      await request(config, "DELETE", path(endpointId), undefined, options.signal, "rate_limit")
    },

    async rotate(endpointId, options = {}) {
      const route = path(endpointId, "/rotate")
      return rotatedFrom(await request(config, "POST", route, undefined, options.signal, "rate_limit"))
    },
  }
}
