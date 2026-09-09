// Incremental history transmission, both phases — the opencode plugin's
// implementation (the sibling plugin, from the "Incremental
// history, phase 1" banner through `advanceHistory`) ported one to one. Spec:
// the design notes; the port notes are
// in the design notes
//
// Framework-neutral: no AI SDK import, no transport. A host (src/vercel) owns the
// flattened history and the ancestor chain; this module decides what goes out and
// remembers what the server proved it received. Two beliefs, both per instance:
//
//   Phase 1  an ancestor's context travels ONCE per snapshot, and only to a backend
//            that has proven it implements the skip-and-report guard;
//   Phase 2  the conversation history goes out as an order-preserving SUBSEQUENCE
//            chosen by rules R1-R4, never as "what's new".
//
// Every belief moves on a 2xx and on nothing else: a send that can still fail
// must not advance a baseline, because a message dropped from a delta is dropped
// from the export forever.
//
// Hashes are async, unlike opencode's, because the SDK hashes through WebCrypto.
// The values are identical.
import { sha256 } from "./trajectory.ts"

/** One flattened history entry: the wire shape. */
export type HistoryMessage = Record<string, string> & { role: string; content: string }

/** A flattened entry PLUS the identity the delta needs. The wire carries no id;
 *  the host assigns one at build time (`"\u0000pos:" + index` where messages have
 *  none of their own). */
export type FlatMessage = { id: string; entry: HistoryMessage }

/** The mode, read per call: `ancestors` (default) is phase 1, `history` is both
 *  phases, `off` is the kill switch. Anything unrecognized is the DEFAULT, not
 *  `off` — the rollback lever is the exact word. */
export type IncrementalMode = "ancestors" | "history" | "off"

export function incrementalMode(raw: unknown): IncrementalMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return value === "off" || value === "history" ? value : "ancestors"
}

/** The env, read the way config.ts reads it: absent on a host with no `process`. */
function env(name: string): string | undefined {
  const value = globalThis.process?.env?.[name]
  return typeof value === "string" ? value : undefined
}

// Snapshot keys are one-way hashes, so idle-eviction is impossible and the caches
// are bounded by count alone. An eviction costs one redundant full re-send — the
// safe direction.
export const DELIVERED_CAP = 4096
export const CAPABILITY_CAP = 64
export const HISTORY_WATERMARK_CAP = 256

export const MISSING_SNAPSHOTS = "missing_snapshots"

/** What `previous_search_index` cuts on, verbatim (session_exporter.py). */
export const SEARCH_MARKER = "[tool telem_search:"

/** Insertion-ordered LRU set: re-adding refreshes recency. */
export function createLruSet(cap: number) {
  const entries = new Map<string, true>()
  return {
    has: (key: string): boolean => entries.has(key),
    add(key: string): void {
      entries.delete(key)
      entries.set(key, true)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    remove(key: string): void {
      entries.delete(key)
    },
  }
}

/** The same bound over values. Recency moves on WRITE only: a read must stay
 *  side-effect-free, because the history delta reads the watermark while building
 *  a request that has not been acknowledged yet. */
export function createLruMap<V>(cap: number) {
  const entries = new Map<string, V>()
  return {
    get: (key: string): V | undefined => entries.get(key),
    set(key: string, value: V): void {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

/** The cache scope: base URL plus a HASH of the key. Node ids are derived from
 *  the account key server-side, so a different key is a different world. */
export async function cacheScope(baseUrl: string, apiKey?: string): Promise<string> {
  return baseUrl + " " + (await sha256(apiKey ?? ""))
}

export function deliveredKey(scope: string, snapshotKey: string): string {
  return scope + "\u0000" + snapshotKey
}

/** One ancestor entry this call chose not to send the context for. `entry` is the
 *  very object inside `ancestors`, so restoring is a swap on the body about to be
 *  re-sent — same node_key, same everything else. */
export type OmittedContext = {
  key: string
  entry: Record<string, unknown>
  context: unknown
}

/** One call's two unacknowledged promises, held until the response proves or
 *  discards them. */
export type DeliveryPlan = {
  scope: string
  /** Snapshot keys this request carries FULL context for: what a 2xx proves. */
  sentWithContext: string[]
  /** What this request WITHHELD, kept whole for the guard's 409. Empty is also
   *  the gate: a 409 on a request that omitted nothing is a plain error. */
  omitted: OmittedContext[]
  /** The epoch is a guess (the host could not read its own state); the history
   *  then goes out in FULL. */
  epochDegraded: boolean
  history?: HistorySend
}

export function newDeliveryPlan(scope: string): DeliveryPlan {
  return { scope, sentWithContext: [], omitted: [], epochDegraded: false }
}

/** Is this error the guard asking for the contexts back? A 409 while something was
 *  omitted, whose code is `missing_snapshots` or unreadable: an unnamed 409 is
 *  treated as the refusal (the retry is one round trip; the other guess costs the
 *  user a failed call on the one condition this path heals), a differently named
 *  one is somebody else's error. */
export function isMissingSnapshotsRefusal(
  error: { status?: number; code?: string },
  plan: DeliveryPlan,
): boolean {
  if (error.status !== 409 || !plan.omitted.length) return false
  return error.code === undefined || error.code === MISSING_SNAPSHOTS
}

// ---------------------------------------------------------------------------
// Phase 2 — the exporter-parity history delta.
// ---------------------------------------------------------------------------

/** The generation a watermark belongs to. `session_key` alone is not monotonic
 *  and is best-effort; the last flattened id plus the count pin it down. */
export type HistoryEpoch = { sessionKey: string; lastMsgId: string; msgCount: number }

/** message id -> hash of the flattened (content, reasoning) LAST PROVEN SENT. */
export type HistoryWatermark = { epoch: HistoryEpoch; hashes: Map<string, string> }

/** What one call promised to the baseline. */
export type HistorySend = {
  conversationKey: string
  epoch: HistoryEpoch
  sent: Array<{ id: string; hash: string }>
}

export type HistorySelection = { entries: HistoryMessage[]; sent: Array<{ id: string; hash: string }> }

/** Over the CAPPED bytes — exactly what goes on the wire, which is what makes the
 *  text cap parity-safe. NUL separates the two fields. */
export async function historyHash(entry: HistoryMessage): Promise<string> {
  return await sha256(entry.content + "\u0000" + (entry.reasoning ?? ""))
}

/** Everything, with its hash: the first call of a generation, and every call the
 *  epoch rules refuse to trust. */
export async function fullHistorySend(flat: readonly FlatMessage[]): Promise<HistorySelection> {
  const hashes = await Promise.all(flat.map((message) => historyHash(message.entry)))
  return {
    entries: flat.map((message) => message.entry),
    sent: flat.map((message, index) => ({ id: message.id, hash: hashes[index] })),
  }
}

/** R1-R4 over one flattened snapshot, against the hashes proven delivered. */
export async function historyDelta(
  flat: readonly FlatMessage[],
  hashes: Map<string, string>,
): Promise<HistorySelection> {
  const include = new Set<number>()
  // The reasoning strings carried by R1-selected entries — and ONLY those.
  const boosters = new Set<string>()
  const hashOf = await Promise.all(flat.map((message) => historyHash(message.entry)))
  for (let i = 0; i < flat.length; i++) {
    const { id, entry } = flat[i]
    if (hashes.get(id) !== hashOf[i]) {
      // R1 — new or changed, sent whole. The mutating tail always lands here.
      include.add(i)
      if (entry.reasoning) boosters.add(entry.reasoning)
    } else if (entry.role === "user") {
      // R2 — every user turn, always.
      include.add(i)
    } else if (entry.role === "assistant" && entry.content.includes(SEARCH_MARKER)) {
      // R3 — every telem_search-marker-bearing message.
      include.add(i)
    }
  }
  // R3's other half: the LAST flattened message, always.
  if (flat.length) include.add(flat.length - 1)
  // R4 — every earlier occurrence of a reasoning string this delta's R1 set carries.
  for (let i = 0; i < flat.length; i++) {
    if (include.has(i)) continue
    const reasoning = flat[i].entry.reasoning
    if (reasoning && boosters.has(reasoning)) include.add(i)
  }
  const chosen = [...include].sort((a, b) => a - b) // subsequence, never a re-order
  return {
    entries: chosen.map((i) => flat[i].entry),
    sent: chosen.map((i) => ({ id: flat[i].id, hash: hashOf[i] })),
  }
}

/** Is the current snapshot the append-only continuation the watermark was built
 *  on? The remembered last message must still be there, at or before where it
 *  sat. With positional ids this reduces to "the list did not shrink" (plan). */
export function continuesEpoch(previous: HistoryEpoch, flat: readonly FlatMessage[]): boolean {
  const at = flat.findIndex((message) => message.id === previous.lastMsgId)
  return at >= 0 && at <= previous.msgCount - 1
}

function historyKey(scope: string, conversationId: string): string {
  return scope + "\u0000" + conversationId
}

/** One ancestor entry as it rides in `ancestors`: a snapshot copy that may carry
 *  `context` or `context_omitted`. */
export type PlannedAncestor = Record<string, unknown>

export type IncrementalOptions = {
  /** The mode, resolved per call. Default: `TELEM_INCREMENTAL` from the env. */
  mode?: () => IncrementalMode
  /** The differential harness's bypass of the capability probe. Default:
   *  `TELEM_INCREMENTAL_FORCE=1` from the env. Never production. */
  forced?: () => boolean
}

/**
 * One instance's beliefs — the equivalent of one opencode plugin instance's
 * factory closure. A host creates one per root agent and shares it with every
 * child, so a child never re-sends what its parent already proved.
 */
export function createIncrementalState(options: IncrementalOptions = {}) {
  const mode = options.mode ?? (() => incrementalMode(env("TELEM_INCREMENTAL")))
  const forced = options.forced ?? (() => env("TELEM_INCREMENTAL_FORCE") === "1")
  /** (scope, snapshot) pairs whose context is proven landed. */
  const delivered = createLruSet(DELIVERED_CAP)
  /** Scopes whose backend implements the guard. */
  const capability = createLruSet(CAPABILITY_CAP)
  /** Per (scope, conversation): the generation and the bytes proven delivered. */
  const historyWatermarks = createLruMap<HistoryWatermark>(HISTORY_WATERMARK_CAP)

  /** Does THIS call omit context for snapshots already delivered to `scope`? */
  function omitsDeliveredContext(scope: string): boolean {
    if (mode() === "off") return false
    if (forced()) return true
    return capability.has(scope)
  }

  /**
   * Copy the root-first chain into the entries this call sends. A snapshot this
   * scope has proven delivered goes out as `context_omitted: true`, its context
   * kept on the plan for the guard's 409; every other entry carries `context` and
   * its key goes on `sentWithContext`. Published only once the whole chain is
   * final, so a throw mid-way marks nothing.
   */
  function planAncestors(
    plan: DeliveryPlan,
    chain: readonly Record<string, unknown>[],
  ): PlannedAncestor[] {
    const omit = omitsDeliveredContext(plan.scope)
    const entries: PlannedAncestor[] = []
    const sentWithContext: string[] = []
    const omitted: OmittedContext[] = []
    for (const snapshot of chain) {
      const entry: PlannedAncestor = { ...snapshot }
      const key = typeof snapshot.node_key === "string" ? snapshot.node_key : undefined
      if (key !== undefined && omit && delivered.has(deliveredKey(plan.scope, key))) {
        const context = entry.context
        delete entry.context
        entry.context_omitted = true
        omitted.push({ key, entry, context })
      } else if (key !== undefined) {
        sentWithContext.push(key)
      }
      entries.push(entry)
    }
    plan.sentWithContext = sentWithContext
    plan.omitted = omitted
    return entries
  }

  /**
   * The history this call sends, and the promise it records against the
   * baseline. Reads shared state; never writes it — the baseline moves in
   * `recordDelivery`, on a response.
   */
  async function planHistory(
    plan: DeliveryPlan,
    conversationId: string,
    sessionKey: string,
    flat: readonly FlatMessage[],
  ): Promise<HistoryMessage[]> {
    if (mode() !== "history") return flat.map((message) => message.entry)
    const epoch: HistoryEpoch = {
      sessionKey,
      lastMsgId: flat.length ? flat[flat.length - 1].id : "none",
      msgCount: flat.length,
    }
    const previous = historyWatermarks.get(historyKey(plan.scope, conversationId))
    const continuous =
      previous !== undefined &&
      !plan.epochDegraded &&
      previous.epoch.sessionKey === epoch.sessionKey &&
      continuesEpoch(previous.epoch, flat)
    const chosen = continuous ? await historyDelta(flat, previous.hashes) : await fullHistorySend(flat)
    plan.history = { conversationKey: conversationId, epoch, sent: chosen.sent }
    return chosen.entries
  }

  /** UNION, never assign: every entry is a fact, so folding a second call's sends
   *  into a first call's watermark is right even when they overlap. Replace only
   *  on a generation change. */
  function advanceHistory(plan: DeliveryPlan): void {
    const send = plan.history
    if (!send) return
    const key = historyKey(plan.scope, send.conversationKey)
    const current = historyWatermarks.get(key)
    if (!current || current.epoch.sessionKey !== send.epoch.sessionKey) {
      const hashes = new Map<string, string>()
      for (const { id, hash } of send.sent) hashes.set(id, hash)
      historyWatermarks.set(key, { epoch: send.epoch, hashes })
      return
    }
    for (const { id, hash } of send.sent) current.hashes.set(id, hash)
    current.epoch = send.epoch
    historyWatermarks.set(key, current)
  }

  /**
   * Called only after a response came back ok AND its body parsed. Marks the
   * snapshots that carried context, advances the history baseline, and learns
   * capability from the PRESENCE of `missing_snapshots` — never its truthiness:
   * the healthy value is `[]`. Runs in every mode, `off` included: passive
   * learning, so flipping on needs no warm-up call.
   */
  function recordDelivery(plan: DeliveryPlan, body: unknown): void {
    for (const key of plan.sentWithContext) delivered.add(deliveredKey(plan.scope, key))
    advanceHistory(plan)
    if (!body || typeof body !== "object") return
    if (!(MISSING_SNAPSHOTS in (body as Record<string, unknown>))) return
    capability.add(plan.scope)
    const missing = (body as Record<string, unknown>)[MISSING_SNAPSHOTS]
    if (Array.isArray(missing)) {
      for (const key of missing) delivered.remove(deliveredKey(plan.scope, String(key)))
    }
  }

  /** Put every withheld context back into the entries this call already built.
   *  Un-marking comes FIRST and unconditionally: the 409 falsified the belief. */
  function restoreOmittedContexts(plan: DeliveryPlan): void {
    for (const { key, entry, context } of plan.omitted) {
      delivered.remove(deliveredKey(plan.scope, key))
      delete entry.context_omitted
      entry.context = context
      plan.sentWithContext.push(key)
    }
    plan.omitted = []
  }

  /**
   * One send, plus the single retry the guard's 409 asks for. `send` must throw
   * an error carrying `status` (and `code` when the body named one) on a non-2xx,
   * which is what the SDK's `TelemError` does. The retry re-sends the SAME body
   * object with the contexts restored; a second refusal surfaces.
   */
  async function sendWithOmissionRetry<T>(plan: DeliveryPlan, send: () => Promise<T>): Promise<T> {
    try {
      return await send()
    } catch (error) {
      const shape = error as { status?: number; code?: string }
      if (!isMissingSnapshotsRefusal(shape, plan)) throw error
      restoreOmittedContexts(plan)
      return await send()
    }
  }

  return { planAncestors, planHistory, recordDelivery, sendWithOmissionRetry }
}

export type IncrementalState = ReturnType<typeof createIncrementalState>
