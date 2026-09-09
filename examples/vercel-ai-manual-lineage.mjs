// The same main agent and subagents as vercel-ai-agents.mjs, with the query lineage
// built by hand from the four ids instead of by `@telemai/sdk/vercel`. Read this to
// see what the integration does for you, or use it when your agent loop is not the
// AI SDK's and you want the same result.
//
//   npm run build
//   npm i --no-save ai @ai-sdk/openai-compatible@2 zod
//   export OPENROUTER_API_KEY=...   TELEM_API_KEY=...
//   node examples/vercel-ai-manual-lineage.mjs
//
// The four ids, and where they come from here:
//   conversationId  one per agent, minted when the agent starts; a subagent gets its own
//   windowId        the context window, anchored on the agent's first message
//   messageId       the model turn that makes the call; every call of one turn shares it
//   toolCallId      this call, from the AI SDK
// A subagent carries its parent's snapshot in `ancestors`, so the console shows its
// calls under the turn that started it.
//
// The history a call sends renders every tool call as a marker, `toolMarker(name,
// status, input)`, and ends with the call being made, marked `running`. The
// console reads the conversation's goals from those markers, so the text is a
// contract: use the helper, do not write it by hand.
import { generateText, tool, stepCountIs } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { z } from "zod"
import Telem, { buildMetadata, buildSnapshot, toolMarker, windowAnchor, withTrajectory } from "@telemai/sdk"

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
})
const model = openrouter(process.env.MODEL ?? "deepseek/deepseek-v4-flash")
const telem = new Telem() // TELEM_API_KEY from the environment
const HARNESS = "telem-sdk-example" // names this integration in every derived id; keep it stable

async function runAgent(name, prompt, ancestors = []) {
  // One conversation identity per agent, and the window anchored on its first message.
  const conversationId = crypto.randomUUID()
  const windowId = await windowAnchor([{ role: "user", content: prompt }])
  const history = [{ role: "user", content: prompt }] // what every call sends as message_history
  let turn = 0 // one model turn = one generateText step

  // The lineage for one call of this agent, at this turn. The history ends with
  // this call, marked running.
  const lineage = (toolCallId, toolName, input) =>
    buildMetadata({
      harness: HARNESS,
      conversationId,
      windowId,
      messageId: `${name}-turn-${turn}`,
      toolCallId,
      history: [...history, { role: "assistant", content: toolMarker(toolName, "running", input) }],
      ancestors,
    })

  const tools = {
    telem_search: tool({
      description: "Search the public web with one query.",
      inputSchema: z.object({ query: z.string(), goal: z.string().describe("what this search is for") }),
      execute: async ({ query, goal }, { toolCallId }) => {
        const r = await telem.search(query, withTrajectory({ goal, numResults: 5 }, await lineage(toolCallId, "telem_search", { query, goal })))
        console.log(`[${name}] search: ${query}  (session ${r.sessionId}, parent ${r.raw.parent_trajectory_id ?? "none"})`)
        return r.results.map(({ title, url, summary }) => ({ title, url, summary }))
      },
    }),
    telem_fetch: tool({
      description: "Read the text of one web page by URL.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }, { toolCallId }) => {
        const r = await telem.fetch(url, withTrajectory({ inlineContent: true, inlineMaxChars: 4000 }, await lineage(toolCallId, "telem_fetch", { url })))
        console.log(`[${name}] fetch: ${url}`)
        return r.results[0]?.content ?? ""
      },
    }),
  }

  if (ancestors.length === 0) {
    tools.delegate = tool({
      description: "Spawn a research subagent for one self-contained subtask. Call it once per subtask, all in one turn.",
      inputSchema: z.object({ name: z.string(), brief: z.string() }),
      execute: async ({ name: child, brief }) => {
        // Freeze this agent at this turn. Subagents started in one turn share the
        // snapshot, so they appear side by side under the parent in the console.
        const snapshot = await buildSnapshot({
          harness: HARNESS,
          conversationId,
          windowId,
          messageId: `${name}-turn-${turn}`,
          context: [...history],
          ancestors,
        })
        console.log(`-> ${child}`)
        return await runAgent(child, brief, [...ancestors, snapshot])
      },
    })
  }

  const { text } = await generateText({
    model,
    tools,
    system:
      ancestors.length === 0
        ? "Split the task into subtasks, delegate each one, then synthesize an answer with citations."
        : `You are ${name}. Use telem_search for anything you are not certain of. Stay on your brief; answer compactly with source URLs.`,
    prompt,
    stopWhen: stepCountIs(ancestors.length === 0 ? 8 : 6),
    // After each turn: grow the history the next call sends, with the turn's tool
    // calls as completed markers, and move to the next turn.
    onStepFinish: ({ text, toolCalls }) => {
      if (text) history.push({ role: "assistant", content: text })
      for (const call of toolCalls ?? []) history.push({ role: "assistant", content: toolMarker(call.toolName, "completed", call.input ?? {}) })
      turn += 1
    },
  })
  return text
}

const text = await runAgent(
  "main",
  "Plan the Nintendo and Pokémon parts of a Japan trip over New Year 2026/27: closures, booking " +
    "rules and holiday hours. Delegate the museum research and the Pokémon Center research.",
)
console.log("\n" + text)
