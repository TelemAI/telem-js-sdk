// sessions: the read surface over `GET /v1/sessions` and
// `.../websearch-preprocessor-results`. Python twin: telem/resources/sessions.py
// (`_sessions_from` / `_results_from`).
//
// These are GETs, so there is no version echo and the search gate never runs. The
// per-step result records are PASS-THROUGH: the server's own snake_case, verbatim.

import type { ResolvedConfig } from "../config.ts"
import { asArray, asObject, invalidRequest, isObject, request, type Payload } from "../http.ts"
import type {
  SessionResults,
  SessionsResource,
  SessionSummary,
} from "../types.ts"

function sessionsFrom(body: unknown): SessionSummary[] {
  return asArray(asObject(body).sessions)
    .filter(isObject)
    .map((entry: Payload) => ({
      id: String(entry.id ?? ""),
      createdAt: entry.created_at ?? null,
      updatedAt: entry.updated_at ?? null,
      interactionCount: entry.interaction_count ?? 0,
      latestInteractionAt: entry.latest_interaction_at ?? null,
      raw: entry,
    }))
}

/** `query`/`goal`/`context` are coerced to `""` rather than kept as `null`. They are
 *  text the caller concatenates or prints, so a server that says nothing should not
 *  force a null guard at every use site. */
function resultsFrom(body: unknown): SessionResults {
  const data = asObject(body)
  return {
    sessionId: String(data.session_id ?? ""),
    query: data.query || "",
    goal: data.goal || "",
    context: data.context || "",
    previousPreprocessorResults: asArray(data.previous_preprocessor_results),
    raw: data,
  }
}

/** Bind the sessions resource to one client's configuration. */
export function createSessions(config: ResolvedConfig): SessionsResource {
  // A session id reaches the URL path, so it is encoded rather than interpolated:
  // an id carrying a slash stays ONE path segment instead of addressing a different
  // route. Encoding alone is not enough — `.` and `.` survive it untouched, and URL
  // parsing then resolves the dot segments away (`.` would turn the results route
  // into `/v1/websearch-preprocessor-results`) — so an all-dots id is rejected
  // before anything is sent.
  // An empty id is rejected with it: every other public method rejects empty input
  // rather than round-tripping a request that cannot address anything.
  const path = (sessionId: string, suffix: string) => {
    if (!sessionId || /^\.+$/.test(sessionId)) throw invalidRequest("a session id is required")
    return `/v1/sessions/${encodeURIComponent(sessionId)}/${suffix}`
  }

  return {
    /**
     * List the caller's sessions, most recent first.
     *
     * Requires an API key: sessions are per-caller, and a keyless client gets the
     * server's 401 as a `TelemError` with `status: 401`. There is no client-side
     * pre-flight check.
     *
     * @returns One summary per session, in the server's own order.
     */
    async list(): Promise<SessionSummary[]> {
      return sessionsFrom(await request(config, "GET", "/v1/sessions"))
    },

    /**
     * Fetch the aggregated websearch preprocessor results for a session.
     *
     * @param sessionId - The session id.
     * @returns The session's query, goal and context plus the per-step results.
     */
    async results(sessionId: string): Promise<SessionResults> {
      const route = path(sessionId, "websearch-preprocessor-results")
      return resultsFrom(await request(config, "GET", route))
    },
  }
}
