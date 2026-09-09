// The trajectory-v5 identity helpers, mirroring the Python SDK's _trajectory_v5.py
// (plus `window_anchor` from its _openai_trajectory.py).
//
// Byte-for-byte parity with Python is the contract, not an aspiration: the same
// conversation must derive the same session_key in both languages or the backend
// cannot join a JS surface's rows to a Python surface's. its own suite
// pins that against vectors generated from the Python source.
//
// Every value these produce is derived, never forwarded: a host thread id is an
// opaque string and one raw id in a UUID field 400s every search on that session.
//
// ASYNC, unlike the Python twins, because the digests go through WebCrypto —
// `crypto.subtle.digest` is the only hash the package can reach on Node, Workers
// and the browser alike without a runtime dependency or a static `node:crypto`
// import, and it returns a promise. The VALUES are identical.

import { isObject, type Payload } from "./http.ts"
import type {
  FetchOptions,
  Json,
  SearchOptions,
  SnapshotArgs,
  TrajectoryArgs,
  TrajectoryEnvelope,
  TrajectorySnapshot,
} from "./types.ts"

/** uuid5 namespace for every derived trajectory key. */
export const NS_TRAJECTORY = "443866ab-1b45-5ed8-979e-52fdad07b810"
/** The placeholder for a component the host did not supply. */
export const NONE = "none"

/** Metadata keys the trajectory payload owns. A caller-supplied value for any of
 *  these is dropped rather than allowed to forge identity. */
export const RESERVED_METADATA: ReadonlySet<string> = new Set([
  "message_history",
  "session_key",
  "fingerprint",
  "node_key",
  "kind",
  "parent_node_key",
  "ancestors",
])

const ENCODER = new TextEncoder()

/** The uuid5 namespace as its 16 raw bytes — the first half of every hashed name. */
const NAMESPACE_BYTES = Uint8Array.from(
  NS_TRAJECTORY.replaceAll("-", "").match(/../g) ?? [],
  (pair) => parseInt(pair, 16),
)

function hex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

// `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`: WebCrypto's
// `BufferSource` excludes a SharedArrayBuffer-backed view, and nothing here is one.
async function digest(
  algorithm: "SHA-1" | "SHA-256",
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes))
}

/** `hashlib.sha256(value.encode).hexdigest`. */
export async function sha256(value: string): Promise<string> {
  return hex(await digest("SHA-256", ENCODER.encode(value)))
}

/** The length prefix that keeps concatenation injective: `f"{len(v.encode)}:{v}"`.
 *  The length is the UTF-8 BYTE count, so a CJK component counts 3 per character
 *  and an emoji 4 — a code-unit or code-point count silently forks from Python. */
function lp(value: string): string {
  return `${ENCODER.encode(value).length}:${value}`
}

/** RFC 4122 uuid5 over the trajectory namespace: SHA-1 of (namespace ‖ name), the
 *  first 16 bytes, with the version and variant bits stamped. This is exactly what
 *  `uuid.uuid5` does, reimplemented because WebCrypto has no uuid5 of its own. */
async function uuid5(name: string): Promise<string> {
  const encoded = ENCODER.encode(name)
  const input = new Uint8Array(NAMESPACE_BYTES.length + encoded.length)
  input.set(NAMESPACE_BYTES)
  input.set(encoded, NAMESPACE_BYTES.length)

  const bytes = (await digest("SHA-1", input)).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const chars = hex(bytes)
  return [
    chars.slice(0, 8),
    chars.slice(8, 12),
    chars.slice(12, 16),
    chars.slice(16, 20),
    chars.slice(20),
  ].join("-")
}

/** Stable, non-reversible conversation identity. */
export async function fingerprint(harness: string, conversationId: string): Promise<string> {
  return await sha256(lp(harness) + lp(conversationId))
}

/** Deterministic identity of one context-window generation. */
export async function sessionKey(
  harness: string,
  conversationId: string,
  windowId: string,
): Promise<string> {
  const name = lp(harness) + lp(await sha256(conversationId)) + lp(windowId) + lp(NONE)
  return await uuid5(name)
}

/** Replay-stable event node key for one model tool call. */
export async function eventNodeKey(
  harness: string,
  session: string,
  messageId: string,
  toolCallId: string,
): Promise<string> {
  const name = lp(harness) + lp(session) + lp(messageId) + lp(toolCallId) + lp("event")
  return await uuid5(name)
}

/** Identity of an agent snapshot at a delegation boundary. */
export async function snapshotNodeKey(
  harness: string,
  conversationId: string,
  messageId: string,
): Promise<string> {
  const name = lp(harness) + lp(await sha256(conversationId)) + lp(messageId) + lp("snap")
  return await uuid5(name)
}

/** Stable anchor id for content a host did not assign an id to.
 *  Length-prefixed like every other key component, so concatenation stays injective. */
export async function contentAnchor(...parts: string[]): Promise<string> {
  return await sha256(parts.map(lp).join(""))
}

// --------------------------------------------------------------------------- //
// Window anchoring — Python twin: the Python SDK's _openai_trajectory.py.
// A session_key needs a window id, and a host with no compaction id of its own
// gets one from the content of its first message.
// --------------------------------------------------------------------------- //

export const HISTORY_TEXT_CAP = 128_000
/** Tool inputs rendered into a marker are cut at this many characters (opencode/Python `TOOL_INPUT_CAP`). */
export const TOOL_INPUT_CAP = 128_000

/** Python slices `str` by CODE POINT; a JS `slice` counts UTF-16 units, so an
 *  emoji straddling the boundary would cut differently. Below the cap neither
 *  language cuts anything, so the exact-but-slower path runs only when it must. */
export function cap(value: string): string {
  if (value.length <= HISTORY_TEXT_CAP) return value
  return Array.from(value).slice(0, HISTORY_TEXT_CAP).join("")
}

/** `tool_marker` from the Python SDK's _trajectory_v5.py: one tool call as the
 *  compact acting-trace marker every harness renders into history. The exporter
 *  cuts goals on `[tool telem_search:`, so the text is a contract. Compact JSON,
 *  key order kept, matches Python's `separators=(",", ":")`; an unserializable
 *  input drops the suffix rather than the marker. */
export function toolMarker(name: string, status: string, args: unknown): string {
  let serialized = ""
  try {
    const text = JSON.stringify(args)
    if (typeof text === "string") serialized = text
  } catch {
    serialized = ""
  }
  if (serialized.length > TOOL_INPUT_CAP) serialized = Array.from(serialized).slice(0, TOOL_INPUT_CAP).join("")
  const suffix = serialized ? ` ${serialized}` : ""
  return `[tool ${name || "?"}: ${status}${suffix}]`
}

/** Python's `str` for the shapes a message field can actually hold. Only the
 *  spellings that differ from `String` need naming: `None`/`True`/`False`.
 *  Exact for strings, null and booleans; an object or an integral float differs
 *  (`{'a': 1}`/`1.0` in Python, `[object Object]`/`1` here), and no host emits
 *  those as message content. */
function pyStr(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  return String(value)
}

/** Reduce OpenAI-shaped content (string, block list, or absent) to plain text. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return cap(content)
  if (Array.isArray(content)) {
    const pieces: string[] = []
    for (const block of content) {
      if (typeof block === "string") pieces.push(block)
      else if (isObject(block) && typeof block.text === "string") pieces.push(block.text)
    }
    return cap(pieces.join("\n"))
  }
  return content === null || content === undefined ? "" : cap(pyStr(content))
}

/**
 * Identify this context-window generation by its first message.
 *
 * Messages carry no ids of their own, so the anchor is a content hash. When a
 * caller trims or summarizes the front of the history — the equivalent of a
 * compaction — the anchor moves and a new generation begins.
 *
 * @returns The anchor, or `NONE` when there are no messages at all.
 */
export async function windowAnchor(messages: readonly Json[]): Promise<string> {
  const first = messages[0]
  if (first === undefined) return NONE
  return await contentAnchor(
    first.role === undefined ? "" : pyStr(first.role),
    messageText(first.content),
  )
}

// --------------------------------------------------------------------------- //
// The outgoing metadata block, and the seam that carries it to the wire.
// --------------------------------------------------------------------------- //

/**
 * Assemble the trajectory-v5 metadata block for one event node.
 *
 * Built from the ALLOWLIST (`RESERVED_METADATA`) and nothing else — never by
 * merging caller data — so nothing smuggled in through a host envelope can ride
 * out to the wire. `parent_node_key` is the DIRECT parent's snapshot key, which is
 * the last entry of the root-first chain, or `null` when there is no parent.
 */
export async function buildMetadata(args: TrajectoryArgs): Promise<TrajectoryEnvelope> {
  const [session, fp] = await Promise.all([
    sessionKey(args.harness, args.conversationId, args.windowId),
    fingerprint(args.harness, args.conversationId),
  ])
  return {
    message_history: args.history,
    session_key: session,
    fingerprint: fp,
    node_key: await eventNodeKey(args.harness, session, args.messageId, args.toolCallId),
    parent_node_key: parentNodeKey(args.ancestors),
    ancestors: args.ancestors,
  }
}

/**
 * Freeze one agent at a delegation boundary into the entry its subagents carry in
 * `ancestors`.
 *
 * Keyed on the delegating turn, so subagents started in one turn share one parent
 * node. `context` is the agent's conversation at that moment; the caller copies it
 * if the live history keeps growing.
 */
export async function buildSnapshot(args: SnapshotArgs): Promise<TrajectorySnapshot> {
  const [session, fp, node] = await Promise.all([
    sessionKey(args.harness, args.conversationId, args.windowId),
    fingerprint(args.harness, args.conversationId),
    snapshotNodeKey(args.harness, args.conversationId, args.messageId),
  ])
  return {
    session_key: session,
    fingerprint: fp,
    node_key: node,
    parent_node_key: parentNodeKey(args.ancestors),
    context: args.context,
    spawned_at: args.spawnedAt ?? new Date().toISOString(),
  }
}

/** The DIRECT parent's node key: the last entry of the root-first chain, or null.
 *  Passed through unchecked, like Python's `ancestors[-1].get("node_key")`: a
 *  malformed entry is the backend's 400, not this builder's to police. */
function parentNodeKey(ancestors: readonly Json[]): string | null {
  return (ancestors.at(-1)?.node_key ?? null) as string | null
}

/** The seam key. A SYMBOL, so an envelope can never arrive from parsed JSON, never
 *  survives a `structuredClone` of caller options, and never appears on the published
 *  option surface or in the `.d.ts` — the ONLY way to attach lineage is
 *  `withTrajectory`, which is why lineage cannot be forged through freeform metadata.
 *  A REGISTERED symbol, so the ESM and CJS builds of this package share one key: an
 *  envelope attached by one copy is read by the other. Not re-exported from the
 *  package root; the seam is the function, not the key. */
export const TRAJECTORY: unique symbol = Symbol.for("telem.trajectory")

/** Search / fetch options carrying a pre-built trajectory envelope. Package-internal. */
export type TrajectorySearchOptions = SearchOptions & { [TRAJECTORY]?: TrajectoryEnvelope }
export type TrajectoryFetchOptions = FetchOptions & { [TRAJECTORY]?: TrajectoryEnvelope }

/**
 * Attach a derived lineage envelope to one call's options — the public seam an
 * example or adapter uses to thread trajectory identity onto a search or a fetch.
 *
 * The envelope must come from {@link buildMetadata}: it lands on the wire `metadata`
 * whole, so it is the allowlist — not this function — that keeps caller data out of
 * it, and a `session_key` in it makes the call's own `session` id drop out. One
 * envelope serves both calls; the sending call stamps the node's kind.
 */
export function withTrajectory(options: SearchOptions, envelope: TrajectoryEnvelope): TrajectorySearchOptions
export function withTrajectory(options: FetchOptions, envelope: TrajectoryEnvelope): TrajectoryFetchOptions
export function withTrajectory(
  options: SearchOptions | FetchOptions,
  envelope: TrajectoryEnvelope,
): TrajectorySearchOptions | TrajectoryFetchOptions {
  return { ...options, [TRAJECTORY]: envelope }
}

/**
 * The wire `metadata` for one call, and the session id to send with it.
 *
 * Identity is derived here or it does not exist: a reserved key arriving through the
 * freeform `metadata` option is DROPPED (a forged one is a row the backend joins to
 * the wrong conversation), an envelope attached through `withTrajectory` lands whole
 * and wins over anything under the same name, and the node's `kind` is the endpoint's
 * — the server derives it from the route and 400s a contradiction.
 *
 * When the envelope carries a `session_key`, the caller's `session` is not consulted:
 * the v5 session IS the host's context-window generation, and asserting a second
 * identity would give the backend two answers to one question. `session_key` can
 * only be here via the envelope, which is what keeps this unforgeable.
 */
export function wireMetadata(
  options: SearchOptions | FetchOptions,
  kind: "search" | "fetch",
): { metadata: Payload; sessionId: string | undefined } {
  const metadata: Payload = {}
  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    if (!RESERVED_METADATA.has(key)) metadata[key] = value
  }
  const envelope = (options as { [TRAJECTORY]?: TrajectoryEnvelope })[TRAJECTORY]
  if (envelope !== undefined) Object.assign(metadata, envelope, { kind })
  const sessionId = metadata.session_key === undefined ? options.session : undefined
  return { metadata, sessionId }
}
