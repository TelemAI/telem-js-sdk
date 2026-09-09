# Examples

In order, simple to hard. Each file says at the top what it needs and how to run it.

1. `vercel-ai-agents.mjs` — an agent with subagents on the Vercel AI SDK. Build the tools once with `@telemai/sdk/vercel`, call `generateText`, and every search carries query lineage, subagents included.
2. `search.mjs` — the client on its own: search, several queries in one call, read a page. No agent framework, no lineage.
3. `vercel-ai-manual-lineage.mjs` — the same agent as the first example, with the lineage built by hand from the four ids. Read it to see what the integration does for you.

Also here:

- `basic.ts` — the three client methods with error handling, against a real deployment.
- `lineage.ts` — the hand-built lineage pattern with no framework and no network; runs in a fresh checkout.
- `injected-fetch.ts` — the injectable transport, for edge runtimes and tests.
- `openai-agents.mjs` — the same two approaches on the OpenAI Node SDK with a hand-rolled tool loop.
