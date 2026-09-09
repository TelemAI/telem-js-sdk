// Query lineage across a multi-agent run — the pattern, with no framework and no
// network. Run it in a fresh checkout on Node 22.18+:
//
//   node examples/lineage.ts
//
// A real agent (see vercel-ai-agents.mjs for a runnable Vercel AI SDK version) never
// sees any of this. Each agent owns one conversation identity; every search it makes
// carries a derived envelope so the backend links the searches together, and a
// delegated subagent carries its parent's frozen snapshot so the backend can walk
// child -> parent. Everything here is built from the public helpers.

import assert from "node:assert/strict"
// In your own project, import from "@telemai/sdk".
import Telem, {
  buildMetadata,
  buildSnapshot,
  windowAnchor,
  withTrajectory,
  type TrajectoryEnvelope,
} from "../src/index.ts"

const HARNESS = "telem-sdk-example" // stable per integration; part of every derived id

// A fake transport that records the request body and answers with a minimal
// V2 envelope, so the example runs with no key and no network.
let lastBody: Record<string, unknown> = {}
const telem = new Telem({
  fetch: async (_url, init) => {
    lastBody = JSON.parse(String(init?.body ?? "{}"))
    const body = {
      session_id: crypto.randomUUID(),
      status: "succeeded",
      normalized_schema_version: 2,
      preprocessor_runs: [],
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
})

// One agent's conversation identity. `windowId` anchors on the first message, so it
// changes when the front of the history is trimmed or summarized (a new generation).
type Agent = {
  conversationId: string
  windowId: string
  ancestors: Record<string, unknown>[]
  history: { role: string; content: string }[]
}

async function newAgent(firstMessage: string, ancestors: Record<string, unknown>[] = []): Promise<Agent> {
  return {
    conversationId: crypto.randomUUID(),
    windowId: await windowAnchor([{ role: "user", content: firstMessage }]),
    ancestors,
    history: [{ role: "user", content: firstMessage }],
  }
}

// The envelope for one search: distinct per (message, tool call), carrying this
// agent's ancestry. This is the whole integration — build it, thread it.
function envelopeFor(agent: Agent, messageId: string, toolCallId: string): Promise<TrajectoryEnvelope> {
  return buildMetadata({
    harness: HARNESS,
    conversationId: agent.conversationId,
    windowId: agent.windowId,
    messageId,
    toolCallId,
    history: agent.history,
    ancestors: agent.ancestors,
  })
}

// --- Root agent: one search, no ancestry ------------------------------------
const root = await newAgent("Plan the Nintendo parts of a Japan trip.")
const rootEnvelope = await envelopeFor(root, "root-msg-1", crypto.randomUUID())
await telem.search("Nintendo Museum Kyoto New Year closures 2026", withTrajectory({ goal: "closures" }, rootEnvelope))

const rootMeta = lastBody.metadata as Record<string, string | null>
console.log("root search wire metadata:")
console.log("  session_key   ", rootMeta.session_key)
console.log("  fingerprint   ", rootMeta.fingerprint?.slice(0, 16) + "…")
console.log("  node_key      ", rootMeta.node_key)
console.log("  parent_node_key", rootMeta.parent_node_key)
// No session id was passed here, so none is sent.
assert.equal("session_id" in lastBody, false)

// session_key present ⇒ the SDK omits session_id even when a session id IS passed:
// the derived key wins, unforgeably.
await telem.search("with an explicit session", withTrajectory({ session: crypto.randomUUID() }, rootEnvelope))
assert.equal("session_id" in lastBody, false)

// --- Delegate to a child: it carries the parent's frozen snapshot -----------
// Freeze the parent at the delegation boundary — the entry the child carries as its parent.
const parentSnap = await buildSnapshot({
  harness: HARNESS,
  conversationId: root.conversationId,
  windowId: root.windowId,
  messageId: "root-delegate-1",
  context: root.history,
  ancestors: root.ancestors,
})
const child = await newAgent("Research the Nintendo Museum specifically.", [...root.ancestors, parentSnap])
const childEnvelope = await envelopeFor(child, "child-msg-1", crypto.randomUUID())
await telem.search("Nintendo Museum lottery booking rules", withTrajectory({ goal: "booking" }, childEnvelope))

const childMeta = lastBody.metadata as Record<string, unknown>
console.log("\nchild search wire metadata:")
console.log("  session_key    ", childMeta.session_key, "(its own — a different conversation)")
console.log("  parent_node_key", childMeta.parent_node_key, "(points at the parent snapshot)")
console.log("  ancestors      ", (childMeta.ancestors as unknown[]).length, "entry (root-first)")

// The link the backend walks: the child's parent_node_key is the parent's snapshot key.
assert.equal(childMeta.parent_node_key, parentSnap.node_key)
assert.notEqual(childMeta.session_key, rootEnvelope.session_key)

// A caller cannot forge lineage through the freeform metadata bag — reserved keys
// are stripped, so only withTrajectory can set them.
await telem.search("anything", { metadata: { session_key: "forged", fingerprint: "forged" } })
const forgedMeta = lastBody.metadata as Record<string, unknown>
assert.equal(forgedMeta.session_key, undefined)
assert.equal(forgedMeta.fingerprint, undefined)

console.log("\nOK — child links to parent, session_key wins over session id, forged keys stripped.")
