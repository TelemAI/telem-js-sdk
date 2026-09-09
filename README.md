# Telem JavaScript SDK

Full documentation: [docs.telem.ai](https://docs.telem.ai/sdks/javascript/).



> **Fastest install: [the one-line curl](https://docs.telem.ai/).** It finds the agent frameworks you have
> and installs Telem into the ones you select. The steps below are the manual path.

`@telemai/sdk` is a typed TypeScript client for the Telem search API. It searches the
web across providers and returns the results in the same shape for every provider.
It also reads pages, lists the providers, and carries query lineage for agents.

The package has no runtime dependencies. It uses the platform `fetch`, and you can
supply your own. So the package runs on Node, in an edge worker, inside another CLI,
and in tests.

## Install

```bash
npm install @telemai/sdk
```

The package ships ESM and CommonJS builds with type definitions. Node 20.16 or later
is necessary to read the credentials file. On other runtimes that have `fetch`, such
as edge workers and browsers, pass the API key in code.

## Authentication

Create an API key under **API keys** in the [Telem console](https://app.telem.ai/).
The guided installer writes it to `~/.telem/credentials.json`. You can also set it
as an environment variable, or pass it in code.

The client resolves `apiKey` and `baseUrl` in this order. The first value found wins:

1. A constructor argument.
2. The `TELEM_API_KEY` and `TELEM_BASE_URL` environment variables.
3. `~/.telem/credentials.json`.
4. The defaults: no key, and `https://router.telem.ai` for `baseUrl`.

See [Authentication](https://docs.telem.ai/authentication/) for the full rules.

```ts

const telem = new Telem          // environment, then ~/.telem/credentials.json
const telem = new Telem("tlm_...") // just a key
const telem = new Telem({
  apiKey: "tlm_...",
  baseUrl: "https://router.telem.ai",
  timeoutMs: 60_000,  // per attempt
  maxRetries: 2,      // on 5xx, network errors and 429
  tier: "extended",   // client-wide search defaults go here
})
```

The credentials file is the only file the client opens. The client never reads
`.telem/telem.json`, the file the other Telem tools use for
[search options](https://docs.telem.ai/resources/config-reference/). A library must not let a
checked-out repository control the spend of a program. Set search defaults as
constructor options or call arguments. The `TELEM_*` variables apply below them.

## Search

One call searches every provider in the default set. The results come back in one
list, in the same shape for every provider:

```ts
const response = await telem.search("best typescript http client")
for (const result of response.results) {
  console.log(result.provider, result.title, result.url)
}
```

Every option applies to one call. An option you do not set uses the client default,
then the server default:

```ts
const response = await telem.search("climate policy 2026", {
  tier: "extended",            // minimalist | default | extended | max
  providersInclude: ["exa"],   // allow-list; omit for the default provider set
  numResults: 10,              // rows per provider (server default 5, maximum 20)
  includeFullContent: true,    // the full page content, not only a summary
  goal: "brief the user",      // recorded with the search; shown in the console
  context: "the user wants the 2026 amendments, not the original 2024 text",
})
```

The full option set is `tier`, `fields`, `providersInclude`, `providersExclude`,
`providerOverrides`, `numResults`, `includeRaw`, `includeFullContent` and `rerank`,
plus `goal`, `context`, `session` and `metadata`. An `undefined` value is unset. `[]`
and `false` are explicit values. `tier` and `fields` do not go together, and the
client sends one of them. When you set both provider lists, the client removes the
excluded names from the allow-list. The client does not validate values. An unknown
tier, field or provider name comes back as an error from the server. See
[Errors](#errors).

**[Full parameter reference →](https://docs.telem.ai/resources/config-reference/)** lists every key, its
environment variable and the precedence. `numResults`, `includeRaw`, `rerank` and
`providerOverrides` are call arguments only. As client defaults they do nothing.

### `goal` and `context`

Telem records both with the search and shows them in the trajectory view in the
console. A reader of the trace then sees why the search happened. For an agent, use
the reasoning of the model for this step as `context`: two or three sentences.
`goal` and `context` change the result order only when you also set
[rerank](#rerank).

### Multi-query batching

Pass an array of queries. They run at the same time, as one request. Each provider
run carries the query it served:

```ts
const response = await telem.search([
  "EU AI Act obligations for general-purpose models 2026",
  "how the amended EU AI Act timeline changed",
])
for (const run of response.byProvider) {
  console.log(run.batchIndex, run.query, run.provider, run.results.length)
}
```

`response.results` is the flat list across every run. An array with one query
behaves the same as a plain string.

### `SearchResponse` shape

```ts
response.results       // flat SearchResult[]: providers in run order, rows in provider order
response.byProvider    // ProviderRun[]: one entry per provider, failed providers included
response.sessionId     // the session this call belongs to
response.interactionId // the id of this request
response.status        // "succeeded" | "partially_succeeded" | "failed"
```

`byProvider` has one run for each provider that ran. A provider that failed is still
in the list, with `status` and `error` set and `results` empty. Each result has
`url`, `title`, `summary`, `excerpt`, `fullContent`, `publishDate`, `rank`,
`thumbnail`, `favicon`, `source`, `enrichments` and `fetchMeta`, plus `provider` and
`raw`. `raw` is the row exactly as the server sent it.

### Rerank

Set `rerank: true` and the server sorts the results by relevance to your `context`.
If there is no `context`, it uses your `goal`. Rerank is off by default, and it is
metered. Set it for one call, not as a client default:

```ts
const response = await telem.search("Nintendo Museum New Year closure dates", {
  context: "planning a late-December visit; need official closure dates, not reviews",
  rerank: true,
})
```

## Fetch a page

Read the content of a URL you already have. Pass one URL or a list. The results come
back in the order you asked for, including the URLs that failed:

```ts
const page = await telem.fetch("https://example.com/article", {
  inlineContent: true,
  inlineMaxChars: 20_000,
  contentFormat: "markdown",
})
const { status, content } = page.results[0]
```

A URL that failed still returns a result. Check `result.status` and `result.error`.
Do not expect a shorter list. The options are on the
[fetch parameters](https://docs.telem.ai/resources/fetch-parameters/) page.

## Providers

List the providers the deployment can run:

```ts
for (const provider of await telem.providers) {
  console.log(provider.name, provider.activeByDefault, provider.tiers)
}
```

## Sessions

Every search belongs to a session. The response carries its id as `sessionId`. Read
your sessions back to see what an agent searched for. Both methods require an API key:

```ts
for (const session of await telem.sessions.list) {
  console.log(session.id, session.interactionCount, session.latestInteractionAt)
}

const summary = await telem.sessions.results(sessionId)
console.log(summary.query, summary.goal, summary.context)
```

`results` returns the query, the goal and the context of the session, plus the
results of each search step.

## Vercel AI SDK

If your agent runs on the Vercel AI SDK, `@telemai/sdk/vercel` gives it
`telem_search` and `telem_fetch` tools with query lineage attached to every call,
subagents included. Build the tool set once per conversation and pass it to
`generateText`:

```ts
import { generateText } from "ai"
import Telem from "@telemai/sdk"
import { createTelemVercelTools } from "@telemai/sdk/vercel"

const telem = new Telem
const tools = createTelemVercelTools({ telem, harness: "my-app" })

const result = await generateText({ model, tools, prompt: "Is the Nintendo Museum open over New Year?" })
```

A subagent is a `generateText` started inside one of your tools. Pass that tool to
`createTelemVercelTools` and use the same tool set inside the subagent; its calls
then appear in the console under the tool call that started it. `ai` version 5
or later is an optional peer dependency, used by this subpath only. The full
guide, subagents, your own tools, and the options, is on the
[Vercel AI SDK page](https://docs.telem.ai/integrations/vercel-ai/). The runnable example is `examples/vercel-ai-agents.mjs`
in the SDK source, first in the [examples list](https://github.com/TelemAI/telem-js-sdk/tree/main/examples).

## Query lineage

If your agent uses the Vercel AI SDK, use
[`@telemai/sdk/vercel`](https://docs.telem.ai/integrations/vercel-ai/). It attaches lineage data to
every call by itself, subagents included, and you build nothing below by hand.

Every search and fetch from an agent can carry **lineage data**. Lineage data tells
Telem which conversation made the call, and where in the conversation it happened.
The console then shows all the calls of one conversation together, in order, and
shows which turn made each call. When an agent delegates to other agents, the
console shows their calls under the agent that started them. You build the lineage
data from four ids you already have. The model never sees them.

The example column uses Codex, which has all four ids:

| Id | What it is | Example |
|---|---|---|
| `conversationId` | One id for one agent conversation. Make it when the conversation starts, and keep it. A subagent gets its own. | Codex: the thread id. One thread is one conversation. |
| `windowId` | The id of the current context window. It changes when you trim or summarize the start of the history. | Codex: the window id. Codex makes a new one when it compacts the context. |
| `messageId` | The id of the model turn that makes the call. All the tool calls in one turn share it. | Codex: the turn id. |
| `toolCallId` | The id of this tool call. | Codex: the id of the tool call in that turn. |

In your own code the ids come from your agent loop. This example uses the OpenAI
Node SDK, where the completion id is the turn and each tool call has its own id:

```ts

const telem = new Telem
const openai = new OpenAI
const messages = [{ role: "user" as const, content: "Is the Nintendo Museum open over New Year?" }]
const tools = [
  {
    type: "function" as const,
    function: {
      name: "telem_search",
      description: "Search the public web.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, goal: { type: "string" }, context: { type: "string" } },
        required: ["query", "goal", "context"],
      },
    },
  },
]

const conversationId = crypto.randomUUID     // once, when the conversation starts
const windowId = await windowAnchor(messages)  // once, from the first message

const completion = await openai.chat.completions.create({ model: "gpt-4o", messages, tools })
for (const call of completion.choices[0].message.tool_calls ?? []) {
  if (call.type !== "function") continue
  const { query, goal, context } = JSON.parse(call.function.arguments)
  const lineage = await buildMetadata({
    harness: "my-app",         // a stable name for your integration
    conversationId,
    windowId,
    messageId: completion.id,  // this model turn
    toolCallId: call.id,       // this tool call
    history: [                 // [{ role, content }]: the conversation so far, ending with this call
      ...messages,
      { role: "assistant", content: toolMarker("telem_search", "running", { query, goal, context }) },
    ],
    ancestors: [],             // the parent snapshot; [] for the first agent
  })
  const response = await telem.search(query, withTrajectory({ goal, context }, lineage))
}
```

`history` has a rule the console depends on, and the example follows it on its
`history` line: write each tool call into the history as a marker with
`toolMarker(name, status, input)`, and end the history of every call with the
call being made, marked `running`. When a call completes, keep its marker in the
history as `completed`. The console reads the conversation's goals from those
markers, so build them with the helper rather than by hand.

`withTrajectory` attaches the lineage data to one call. Use it the same way with
`telem.fetch`. When lineage data is present, the client ignores a `session` id.

When an agent delegates a task, it makes a **snapshot** of itself with
`buildSnapshot`. The snapshot is a record of the parent at that moment. The subagent
carries the snapshot in its own `ancestors`. Subagents that start in the same turn
share the snapshot, and the console shows them side by side under the parent:

```ts

const parent = await buildSnapshot({
  harness: "my-app",
  conversationId,
  windowId,
  messageId: completion.id,  // the turn that delegates
  context: messages,         // the conversation at that moment
  ancestors: [],
})
// in the subagent: ancestors: [parent]
```

**Without lineage data**, pass the `sessionId` from the response back as `session`
on each later call. The console then shows the calls together, but not which turn
made each one. Make the first call alone. Until its response returns, there is no
id to share, and two calls that start together end up in two separate sessions.

## Errors

The client throws exactly two error classes. Branch on `status` and `code`. Do not
branch on the message text:

```ts

try {
  await telem.search("climate policy 2026")
} catch (error) {
  if (error instanceof TimeoutError) {
    // error.code === "timeout": one attempt took longer than timeoutMs
  } else if (error instanceof TelemError) {
    error.status  // the HTTP status, or undefined when nothing was sent
    error.code    // "invalid_request" | "unsupported_server_version" | "connection_error", or a server code
    error.details // the parsed response body, or the raw text
  }
}
```

| Situation | Result |
|---|---|
| Bad input (empty query, empty URL list) | `TelemError`, `code: "invalid_request"`, nothing sent |
| Network failure | `TelemError`, `code: "connection_error"`, after the retries |
| 5xx or 429 | Retried with backoff (`Retry-After` applies), then `TelemError` with the status |
| Other 4xx | `TelemError` with the status and the code from the server, not retried |
| Attempt longer than `timeoutMs` | `TimeoutError`, not retried |

See [Resources → Errors](https://docs.telem.ai/resources/errors/) for how the plugins show a failed call.

## Embedding and edge runtimes

The client has no HTTP dependency, and it accepts your own `fetch`. This is how it
runs inside another platform, in an edge worker, and in tests without a network:

```ts
const telem = new Telem({
  apiKey: env.TELEM_API_KEY,
  fetch: (input, init) => myFetch(input, init), // a worker, a proxy, a recording stub
})
```

## License

Apache-2.0. See [LICENSE](LICENSE).
