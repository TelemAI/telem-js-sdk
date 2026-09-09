// Two ways to thread an agent's Telem calls into one session, on the OpenAI Node
// SDK with a hand-rolled tool loop. (On the Vercel AI SDK, `@telemai/sdk/vercel`
// does all of this for you: see vercel-ai-agents.mjs.
//
//   Part 1 — one agent, session id.
//     The simple path. The first response returns a sessionId; pass it back as
//     `session` on every later call. The console shows the calls of the run
//     together, in the order they arrived.
//
//   Part 2 — a main agent with subagents, lineage envelope.
//     Each agent owns one conversation identity. Every search and fetch carries a
//     derived envelope, so the console shows which turn made each call and
//     shows a subagent's calls under the agent that started it. No session id
//     is passed back — the envelope's session_key IS the session. The model never
//     sees any lineage field.
//
// Needs the built package, one peer package and two keys (this SDK depends on neither):
//   npm run build                 # the examples import the built package
//   npm i --no-save openai        # --no-save: keep it out of the SDK's package.json
//   export OPENROUTER_API_KEY=...   TELEM_API_KEY=...
//   node examples/openai-agents.mjs            # both parts, in order
//   node examples/openai-agents.mjs session    # part 1 only
//   node examples/openai-agents.mjs lineage    # part 2 only
//
// The OpenAI client talks to OpenRouter, so MODEL picks any tool-calling model there.

import OpenAI from "openai"
import Telem, { buildMetadata, buildSnapshot, windowAnchor, withTrajectory } from "@telemai/sdk"

// ---- Shared by both parts ---------------------------------------------------
const MODEL = process.env.MODEL ?? "deepseek/deepseek-v4-flash"
const openai = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY })
const telem = new Telem() // TELEM_API_KEY / TELEM_BASE_URL from the environment
const TODAY = new Date().toISOString().slice(0, 10)

// The tools, in OpenAI function-calling shape. `goal` and `context` are recorded
// on the search node and shown in the trajectory view, so a reader sees WHY each
// call happened.
const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "telem_search",
    description: "Search the public web with one query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        goal: { type: "string", description: "what this search is for, a few words" },
        context: {
          type: "string", maxLength: 600,
          description: "Two or three sentences of your reasoning: what you want to find out and why, " +
            "given what you already know. Not a restatement of the query.",
        },
      },
      required: ["query", "goal", "context"],
    },
  },
}
const FETCH_TOOL = {
  type: "function",
  function: {
    name: "telem_fetch",
    description: "Fetch the readable text of one known URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        goal: { type: "string", description: "what you want from this page, a few words" },
      },
      required: ["url", "goal"],
    },
  },
}
const DELEGATE_TOOL = {
  type: "function",
  function: {
    name: "delegate",
    description: "Spawn a research subagent for one self-contained subtask. Call several times to parallelize.",
    parameters: {
      type: "object",
      properties: { agent_name: { type: "string" }, brief: { type: "string" } },
      required: ["agent_name", "brief"],
    },
  },
}

const compact = (r) =>
  r.results.slice(0, 12).map(({ provider, title, url, summary }) => ({ provider, title, url, summary }))
const pageOf = (r) =>
  ({ status: r.results[0]?.status, content: (r.results[0]?.content ?? "").slice(0, 4000) })

/** A minimal agent loop: ask the model, run every tool call it made, append the
 *  results, repeat until it answers in text. This is what `generateText` does for
 *  you in vercel-ai-agents.mjs. Each handler gets the tool input plus the ids a
 *  lineage envelope keys on: the completion id (this model turn) and the call id. */
async function runLoop({ messages, tools, handlers, maxTurns }) {
  for (let turn = 0; turn < maxTurns; turn++) {
    const completion = await openai.chat.completions.create({ model: MODEL, messages, tools })
    const message = completion.choices[0].message
    // Keep exactly the fields the next request needs: strict providers reject
    // extras, and reasoning models want theirs back.
    messages.push(Object.fromEntries(
      ["role", "content", "tool_calls", "reasoning", "reasoning_details"]
        .filter((k) => message[k] != null).map((k) => [k, message[k]])))
    if (!message.tool_calls?.length) return message.content ?? ""
    const results = await Promise.all(message.tool_calls.map(async (call) => {
      const input = JSON.parse(call.function.arguments || "{}")
      const output = await handlers[call.function.name](input, { messageId: completion.id, toolCallId: call.id, turn })
      return { role: "tool", tool_call_id: call.id, content: JSON.stringify(output) }
    }))
    messages.push(...results)
  }
  return "(turn cap reached)"
}

/** What Telem accepted for one agent: its session, its calls, and the parent link. */
function report(name, sessionId, calls, parentTrajectoryId) {
  const nodes = new Set(calls.map((c) => c.trajectoryId)).size
  const parent = parentTrajectoryId === undefined ? "" : `  parent_trajectory_id=${parentTrajectoryId ?? "null"}`
  console.log(`  ${name}: session=${sessionId}  calls=${calls.length}  trajectory nodes=${nodes}${parent}`)
}

// =============================================================================
// Part 1 — one agent, session id
// =============================================================================
const TASK_SINGLE =
  "For a late-December 2026 Japan trip: find the Nintendo Museum's New Year closure dates and " +
  "booking rules, then Super Nintendo World's, and recommend which to book first and why."

async function part1() {
  console.log("\n== Part 1: one agent, sessionId passed back by hand ==")
  let sessionId // undefined on the first call; the backend mints one and returns it
  const calls = []

  // One call at a time: the loop runs a turn's tool calls together, but until the
  // first response returns there is no session id to share, so two calls fired in
  // the first turn would land in two sessions. (Part 2 has no such constraint — its
  // session key is computed client-side.
  let queue = Promise.resolve()
  const oneAtATime = (fn) => (...args) => {
    const run = queue.then(() => fn(...args))
    queue = run.catch(() => {}) // a failed call must not poison the next one
    return run
  }

  const handlers = {
    telem_search: oneAtATime(async ({ query, goal, context }) => {
      console.log(`  search: ${query}`)
      const r = await telem.search(query, { goal, context, numResults: 4, session: sessionId })
      sessionId ??= r.sessionId
      calls.push({ kind: "search", trajectoryId: r.raw.trajectory_id })
      return compact(r)
    }),
    telem_fetch: oneAtATime(async ({ url, goal }) => {
      console.log(`  fetch:  ${url}`)
      // fetch has no goal option; a goal rides in the freeform metadata the same way.
      const r = await telem.fetch(url, {
        session: sessionId, inlineContent: true, inlineMaxChars: 4000, metadata: { goal },
      })
      sessionId ??= r.sessionId
      calls.push({ kind: "fetch", trajectoryId: r.raw.trajectory_id })
      return pageOf(r)
    }),
  }

  const messages = [
    {
      role: "system",
      content:
        `You are a research agent. Today is ${TODAY}. Use telem_search for anything you are not ` +
        "certain of: one query per call, at least three searches over separate turns, each informed " +
        "by the last. Then telem_fetch the single most authoritative official page before answering " +
        "with citations.",
    },
    { role: "user", content: TASK_SINGLE },
  ]
  const text = await runLoop({ messages, tools: [SEARCH_TOOL, FETCH_TOOL], handlers, maxTurns: 8 })
  console.log("\n" + text.slice(0, 600) + "\n")
  report("main", sessionId, calls)
}

// =============================================================================
// Part 2 — main agent + subagents, lineage envelope
// =============================================================================
const TASK_MULTI =
  "Plan the Nintendo/Pokemon parts of a Dec 2026 Japan trip: verify Nintendo Museum and " +
  "Super Nintendo World New Year closure dates and booking rules, and list the Tokyo/Osaka " +
  "Pokemon Centers with their holiday hours. Delegate the museum and the Pokemon-Center research."

const HARNESS = "telem-sdk-example" // stable per integration; part of every derived key
const runs = [] // one entry per agent that searched, for the report at the end

// The conversation so far, in the shape the envelope carries: role + text, tool
// calls rendered inline, tool results left out (their call already stands for them).
const ROLE = { user: "user", assistant: "assistant", system: "system", developer: "system" }
const textOf = (content) =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n")
  : ""
function historyOf(messages) {
  const history = []
  for (const m of messages) {
    const role = ROLE[m.role]
    if (!role) continue
    const pieces = [textOf(m.content)].filter(Boolean)
    for (const call of m.tool_calls ?? []) pieces.push(`${call.function?.name}(${call.function?.arguments ?? ""})`)
    const content = pieces.join("\n")
    if (!content && !m.reasoning) continue
    history.push(m.reasoning ? { role, content, reasoning: m.reasoning } : { role, content })
  }
  return history
}

async function runAgent(name, prompt, { ancestors = [], depth = 0 } = {}) {
  const messages = [
    {
      role: "system",
      content:
        `You are ${name}. Today is ${TODAY}. Use telem_search for anything you are not certain of, one query per call. ` +
        (depth === 0
          ? "Split the task into subtasks and use delegate for each, then synthesize with citations."
          : "Stay on your brief; return a compact structured answer with source URLs."),
    },
    { role: "user", content: prompt },
  ]
  // One conversation identity per agent; the window anchors on its first message.
  const agent = { conversationId: crypto.randomUUID(), windowId: await windowAnchor(messages), ancestors, messages }
  let sessionId, parentTrajectoryId
  const calls = []

  // Every call carries this agent's envelope. messageId is the completion id (the
  // model turn that made the call); toolCallId tells apart several calls in one
  // turn; history is the conversation so far; ancestors is the parent chain.
  const envelope = ({ messageId, toolCallId }) =>
    buildMetadata({
      harness: HARNESS,
      conversationId: agent.conversationId,
      windowId: agent.windowId,
      messageId,
      toolCallId,
      history: historyOf(messages),
      ancestors: agent.ancestors,
    })
  // The response is where the backend echoes the linkage it accepted.
  const record = (kind, r, turn) => {
    sessionId ??= r.sessionId
    parentTrajectoryId ??= r.raw.parent_trajectory_id ?? null
    calls.push({ kind, turn, trajectoryId: r.raw.trajectory_id })
  }

  const handlers = {
    telem_search: async ({ query, goal, context }, ids) => {
      console.log(`  [${name}] search @turn ${ids.turn}: ${query}`)
      const r = await telem.search(query, withTrajectory({ goal, context, numResults: 4 }, await envelope(ids)))
      record("search", r, ids.turn)
      return compact(r)
    },
    telem_fetch: async ({ url, goal }, ids) => {
      console.log(`  [${name}] fetch  @turn ${ids.turn}: ${url}`)
      // Same envelope as a search: a fetch is one more node in this agent's session.
      const options = { inlineContent: true, inlineMaxChars: 4000, metadata: { goal } }
      const r = await telem.fetch(url, withTrajectory(options, await envelope(ids)))
      record("fetch", r, ids.turn)
      return pageOf(r)
    },
    delegate: async ({ agent_name, brief }, { messageId }) => {
      // Freeze THIS agent as the child's parent. Keyed on the completion id, so
      // subagents started in one turn share one parent node.
      const parentSnap = await buildSnapshot({
        harness: HARNESS,
        conversationId: agent.conversationId,
        windowId: agent.windowId,
        messageId,
        context: historyOf(messages),
        ancestors: agent.ancestors,
      })
      console.log(`  [${name}] -> ${agent_name}`)
      const answer = await runAgent(agent_name, brief, { ancestors: [...agent.ancestors, parentSnap], depth: 1 })
      return { answer }
    },
  }

  const tools = depth === 0 ? [SEARCH_TOOL, FETCH_TOOL, DELEGATE_TOOL] : [SEARCH_TOOL, FETCH_TOOL]
  const text = await runLoop({ messages, tools, handlers, maxTurns: 6 })
  if (sessionId) runs.push({ name, depth, sessionId, calls, parentTrajectoryId })
  return text
}

async function part2() {
  console.log("\n== Part 2: main agent + subagents, lineage envelope ==")
  const answer = await runAgent("main", TASK_MULTI)
  console.log("\n" + answer.slice(0, 600) + "\n")
  for (const run of runs) report(`[${run.depth === 0 ? "root " : "child"}] ${run.name}`, run.sessionId, run.calls, run.parentTrajectoryId)
  const child = runs.find((r) => r.depth === 1)
  console.log(`\nlineage connected: subagents link to a parent trajectory = ${!!child?.parentTrajectoryId}`)
}

// ---- Run --------------------------------------------------------------------
const part = process.argv[2] ?? "both"
console.log(`model: ${MODEL}`)
if (part !== "lineage") await part1()
if (part !== "session") await part2()
