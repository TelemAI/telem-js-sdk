// A main agent with subagents on the Vercel AI SDK. Every Telem search and fetch
// carries query lineage, and each subagent's calls appear in the Telem console
// under the tool call that started it. Nothing here does that by hand.
//
//   npm run build                                       # the example imports the built package
//   npm i --no-save ai @ai-sdk/openai-compatible@2 zod  # --no-save; the provider major must match ai's (2 for ai@6)
//   export OPENROUTER_API_KEY=...   TELEM_API_KEY=...
//   node examples/vercel-ai-agents.mjs
//
// MODEL picks any tool-calling model on OpenRouter. The default returns its
// reasoning, which the console shows next to each call.
import { generateText, tool, stepCountIs } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { z } from "zod"
import Telem from "@telemai/sdk"
import { createTelemVercelTools } from "@telemai/sdk/vercel"

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
})
const model = openrouter(process.env.MODEL ?? "deepseek/deepseek-v4-flash")
const telem = new Telem() // TELEM_API_KEY from the environment

// A subagent is one more generateText, started inside a tool, with the same tools.
const delegate = tool({
  description: "Spawn a research subagent for one self-contained subtask. Call it once per subtask, all in one turn.",
  inputSchema: z.object({ name: z.string(), brief: z.string() }),
  execute: async ({ name, brief }) => {
    console.log(`-> ${name}`)
    const { delegate: _, ...leafTools } = tools // a subagent researches; it does not delegate again
    // On a runtime without AsyncLocalStorage (`telemVercelAutoNesting` is false), link the
    // subagent by hand instead, still without `delegate` so it cannot delegate again:
    //   const { delegate: _, ...leafTools } = await childTelemVercelTools(tools, options)
    // with `options` as the second argument of this execute. Nothing else changes.
    const { text } = await generateText({
      model,
      tools: leafTools,
      system: `You are ${name}. Use telem_search for anything you are not certain of. Stay on your brief; answer compactly with source URLs.`,
      prompt: brief,
      stopWhen: stepCountIs(6),
    })
    return text
  },
})

// Build the tool set once. Every call carries lineage; subagents link by themselves.
const tools = createTelemVercelTools({ telem, harness: "telem-sdk-example", tools: { delegate } })

const { text } = await generateText({
  model,
  tools,
  system: "Split the task into subtasks, delegate each one, then synthesize an answer with citations.",
  prompt:
    "Plan the Nintendo and Pokémon parts of a Japan trip over New Year 2026/27: closures, booking " +
    "rules and holiday hours. Delegate the museum research and the Pokémon Center research.",
  stopWhen: stepCountIs(8),
})
console.log("\n" + text)
