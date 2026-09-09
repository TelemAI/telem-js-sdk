// @telemai/sdk/vercel — Telem search and fetch tools for the Vercel AI SDK, with
// query lineage derived automatically and sent incrementally.
//
// on the tool call itself — `execute(input, options)` hands a tool its
// `toolCallId` and the `messages` the model saw — so the model is never wrapped
// and the user's own middleware, `prepareStep` and wrappers are untouched.
//
// `ai` is an optional peer, imported here and nowhere else in the package, for
// `jsonSchema`: the AI SDK accepts only a zod schema or a schema it branded.
import { jsonSchema, type Schema } from "ai"
import {
  type FlatMessage,
  type HistoryMessage,
  type IncrementalMode,
  type IncrementalState,
  cacheScope,
  createIncrementalState,
  createLruMap,
  newDeliveryPlan,
} from "../incremental.ts"
import { isObject } from "../http.ts"
import type { Telem } from "../index.ts"
import {
  buildMetadata,
  buildSnapshot,
  cap,
  contentAnchor,
  messageText,
  toolMarker,
  windowAnchor,
  withTrajectory,
} from "../trajectory.ts"
import type {
  FetchOptions,
  FetchResponse,
  Json,
  SearchOptions,
  SearchResponse,
  TrajectorySnapshot,
} from "../types.ts"

/** The execute options the integration reads. `ai@5`, `6` and `7` all carry
 *  these three; the type is structural so nothing here depends on the peer's
 *  own declarations. */
export type TelemVercelToolExecutionOptions = {
  toolCallId: string
  /** The messages sent to the model for this step: no system prompt, and not
   *  the assistant message that made the call. */
  messages: readonly unknown[]
  /** Forwarded to the Telem request: an abort stops it and skips the retry. */
  abortSignal?: AbortSignal
}

/** What `onResponse` sees after every successful search and fetch the tools make. */
export type TelemVercelCallEvent =
  | { kind: "search"; agent: TelemVercelAgent; query: string | string[]; response: SearchResponse }
  | { kind: "fetch"; agent: TelemVercelAgent; url: string | string[]; response: FetchResponse }

/** What the model reads back. Defaults: `search` the top results, compact;
 *  `fetch` one page's status, error and text. Applies to subagents too. */
export type TelemVercelRenderOptions = {
  search?: (response: SearchResponse) => unknown
  fetch?: (response: FetchResponse) => unknown
}

/** One tool call, as the history renders it: the current call's `running` marker. */
export type TelemVercelToolCallRef = { name: string; input: unknown }

export type TelemVercelAgentOptions = {
  telem: Telem
  /** Names the integration in every derived key. Required, never defaulted:
   *  it is what keeps one product's rows apart from another's. */
  harness: string
  /** One id per agent conversation. Minted when absent. A chat that spans
   *  several HTTP requests must pass a stable id (the chat id), or every request
   *  becomes its own session. */
  conversationId?: string
  /** The root-first chain this agent hangs under; `child` fills it. */
  ancestors?: readonly TrajectorySnapshot[]
  /** `ancestors` (phase 1, the default), `history` (both phases) or `off`.
   *  Unset reads `TELEM_INCREMENTAL` per call. */
  incremental?: IncrementalMode
  /** What the model reads back from the two tools. Inherited by subagents. */
  render?: TelemVercelRenderOptions
  /** Called after every successful search and fetch, root and subagents alike,
   *  with the agent that made it and the response: for logging and metrics,
   *  without replacing a tool. A throw or a rejection here is swallowed; it
   *  never fails the call. */
  onResponse?: (event: TelemVercelCallEvent) => void | Promise<void>
  /** Advanced: the ledgers to share. `child` passes its parent's, so a child
   *  never re-sends what the parent already proved delivered. */
  incrementalState?: IncrementalState
}

export type TelemVercelSearchInput = { query: string; goal?: string; context?: string }
export type TelemVercelFetchInput = { url: string; goal?: string }
/** The default `render.search`: the top results, compact. */
export type TelemVercelSearchOutput = Array<{ provider: string; title: string; url: string; summary: string | null }>
/** The default `render.fetch`: one page's status, error and text. */
export type TelemVercelFetchOutput = { status: string | undefined; error: unknown; content: string }

/** One AI SDK tool as a plain object: `description`, a branded `inputSchema`,
 *  and `execute`. */
export type TelemVercelTool<INPUT> = {
  description: string
  inputSchema: Schema<INPUT>
  execute: (input: INPUT, options: TelemVercelToolExecutionOptions) => Promise<unknown>
}

export type TelemVercelAgent = {
  /** This conversation's identity: the id every derived key hangs off. */
  readonly conversationId: string
  /** The root-first ancestor chain; empty for a root agent. */
  readonly ancestors: readonly TrajectorySnapshot[]
  readonly telem: Telem
  /** `telem_search` and `telem_fetch`, lineage attached from the execute options. */
  readonly tools: {
    telem_search: TelemVercelTool<TelemVercelSearchInput>
    telem_fetch: TelemVercelTool<TelemVercelFetchInput>
  }
  /** The SDK search with this agent's lineage attached from `execution` — for a
   *  tool of the user's own. Several calls with the same options are distinct nodes. */
  search(
    query: string | string[],
    options?: SearchOptions | null,
    execution?: TelemVercelToolExecutionOptions,
  ): Promise<SearchResponse>
  /** The SDK fetch with this agent's lineage attached from `execution`. */
  fetch(url: string | string[], options?: FetchOptions | null, execution?: TelemVercelToolExecutionOptions): Promise<FetchResponse>
  /** This agent frozen at the calling turn: what its subagents carry. Keyed on
   *  the TURN, so subagents started by several tool calls of one turn share one
   *  snapshot — which is why it carries nothing call-specific: siblings must send
   *  one snapshot key with byte-identical context, or the backend's first writer
   *  fixes a context the others never sent. `spawnedAt` defaults to now. */
  snapshot(execution?: TelemVercelToolExecutionOptions, spawnedAt?: string): Promise<TrajectorySnapshot>
  /** A new agent whose chain ends with this agent's snapshot at the calling
   *  turn, sharing the incremental ledgers. Call it inside the tool that starts
   *  the subagent and hand the child's `tools` to the subagent. */
  child(
    execution?: TelemVercelToolExecutionOptions,
    options?: { conversationId?: string; spawnedAt?: string },
  ): Promise<TelemVercelAgent>
}

const SEARCH_TOOL = "telem_search"
const FETCH_TOOL = "telem_fetch"
const RESULT_CAP = 12
const PAGE_CAP = 4000
const RUNNING = "running"

// --------------------------------------------------------------------------- //
// The flattened history: the Python SDK's _openai_trajectory.py message_history
// on AI SDK ModelMessages (plan).
// --------------------------------------------------------------------------- //

type Part = {
  type?: unknown
  text?: unknown
  toolCallId?: unknown
  toolName?: unknown
  input?: unknown
  args?: unknown
}

/** Tool call ids that have a result: in a later `tool` message, or — for a
 *  provider-executed tool — inside the assistant message itself. */
function answeredCalls(messages: readonly unknown[]): Set<string> {
  const answered = new Set<string>()
  for (const message of messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue
    if (message.role !== "tool" && message.role !== "assistant") continue
    for (const part of message.content) {
      if (isObject(part) && part.type === "tool-result" && typeof part.toolCallId === "string") {
        answered.add(part.toolCallId)
      }
    }
  }
  return answered
}

/**
 * Flatten the messages a tool was called with into the backend's history shape,
 * one entry per message that carries text, reasoning or a tool call, each with
 * its positional identity. `tool` messages are dropped: their calls are already
 * `completed` markers, and a result can be a whole page. Reasoning parts land in
 * `reasoning`, never in `content`.
 *
 * `current` is the call being made right now. It is not in `messages`, and the
 * exporter reads the current call out of the LAST entry, so it is appended as a
 * `running` marker built from the tool's own name and input.
 */
export function telemVercelMessageHistory(messages: readonly unknown[], current?: TelemVercelToolCallRef): FlatMessage[] {
  const answered = answeredCalls(messages)
  const flat: FlatMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!isObject(message)) continue
    const role = message.role
    if (role !== "user" && role !== "assistant" && role !== "system") continue
    const pieces: string[] = []
    const thoughts: string[] = []
    const content = message.content
    if (typeof content === "string") {
      pieces.push(content)
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (typeof raw === "string") {
          pieces.push(raw)
          continue
        }
        if (!isObject(raw)) continue
        const part = raw as Part
        if (part.type === "text" && typeof part.text === "string") pieces.push(part.text)
        else if (part.type === "reasoning" && typeof part.text === "string") thoughts.push(part.text)
        else if (part.type === "tool-call") {
          const id = typeof part.toolCallId === "string" ? part.toolCallId : ""
          const name = typeof part.toolName === "string" ? part.toolName : ""
          const status = answered.has(id) ? "completed" : "pending"
          pieces.push(toolMarker(name, status, part.input !== undefined ? part.input : part.args))
        }
      }
    } else if (content !== null && content !== undefined) {
      pieces.push(messageText(content))
    }
    const text = cap(pieces.join("\n"))
    const reasoning = cap(thoughts.join("\n"))
    if (!text && !reasoning) continue
    const entry: HistoryMessage = { role, content: text }
    if (reasoning) entry.reasoning = reasoning
    flat.push({ id: "\u0000pos:" + index, entry })
  }
  if (current) {
    flat.push({
      id: "\u0000pos:" + messages.length,
      entry: { role: "assistant", content: toolMarker(current.name, RUNNING, current.input) },
    })
  }
  return flat
}

/** The model turn: every tool call of one step sees the same `messages`, so the
 *  count, the window, and the last message (whole, a tool result included) name
 *  the turn; the next step appends and gets a new one. */
async function turnAnchor(messages: readonly unknown[], windowId: string): Promise<string> {
  const last = messages[messages.length - 1]
  let text = ""
  try {
    text = last === undefined ? "" : cap(JSON.stringify(last) ?? "")
  } catch {
    text = isObject(last) ? messageText(last.content) : ""
  }
  return await contentAnchor(String(messages.length), windowId, text)
}

function compact(response: SearchResponse): TelemVercelSearchOutput {
  return response.results
    .slice(0, RESULT_CAP)
    .map(({ provider, title, url, summary }) => ({ provider, title, url, summary }))
}

function page(response: FetchResponse): TelemVercelFetchOutput {
  const first = response.results[0]
  return {
    status: first?.status,
    error: first?.error ?? null,
    content: (first?.content ?? "").slice(0, PAGE_CAP),
  }
}

/** A 2xx whose body was not the router's JSON (a captive portal, a misrouted
 *  proxy) proves nothing: it must not move a watermark or mark a delivery. */
function isInteraction(raw: unknown): boolean {
  return isObject(raw) && "session_id" in raw
}

const SEARCH_SCHEMA = jsonSchema<TelemVercelSearchInput>({
  type: "object",
  properties: {
    query: { type: "string", description: "One search query." },
    goal: { type: "string", description: "What this search is for, in a few words." },
    context: {
      type: "string",
      description:
        "Two or three sentences of your reasoning: what you want to find out and why, " +
        "given what you already know. Not a restatement of the query.",
    },
  },
  required: ["query"],
  additionalProperties: false,
})

const FETCH_SCHEMA = jsonSchema<TelemVercelFetchInput>({
  type: "object",
  properties: {
    url: { type: "string", description: "The http(s) URL to read." },
    goal: { type: "string", description: "What you want from this page, in a few words." },
  },
  required: ["url"],
  additionalProperties: false,
})

// --------------------------------------------------------------------------- //
// Process-wide state. Hung off globalThis under a registered symbol, the way the
// lineage seam uses Symbol.for: tsup emits an ESM and a CJS bundle, and a process
// that loads both must still share one frame store and one set registry.
// --------------------------------------------------------------------------- //

type Frame = {
  /** The set whose tool opened this frame: another set's tools ignore it. */
  owner: SetEntry
  /** The agent of the run this tool call belongs to. */
  agent: Promise<TelemVercelAgent>
  options: TelemVercelToolExecutionOptions
  /** When this tool call began: the delegation moment a child's snapshot records. */
  startedAt: string
  /** Child agents of runs started inside this tool call, by conversation key. */
  children: Map<string, Promise<TelemVercelAgent>>
}

type Frames = { run<R>(store: Frame, fn: () => R): R; getStore(): Frame | undefined }

/** The tool sets this module built: the agent each is bound to, the user's own
 *  tools, and whether the set is explicit (built by `childTelemVercelTools`: bound to
 *  its agent outright, no frame detection, so it never double-nests under a
 *  frame that is also active). */
type SetEntry = { root: TelemVercelAgent; own: Record<string, TelemVercelToolLike> | undefined; explicit: boolean }

type Registry = {
  frames: Frames | undefined
  sets: WeakMap<object, SetEntry>
  /** Execute-options object -> the set whose tool is running with it. */
  owners: WeakMap<object, SetEntry>
  /** A step's messages array -> when its first tool call began. Sibling tool
   *  calls of one step share the array, so they share the delegation moment and
   *  send one byte-identical snapshot. */
  turnStarts: WeakMap<object, { startedAt: string; length: number }>
}

/** Node's AsyncLocalStorage, reached through `process.getBuiltinModule` so the
 *  package keeps no `node:` import in its graph (the credentials reader does the
 *  same). Absent on a runtime without it. */
function loadFrames(): Frames | undefined {
  try {
    const proc = globalThis.process
    if (typeof proc?.getBuiltinModule !== "function") return undefined
    const hooks = proc.getBuiltinModule("node:async_hooks")
    return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage<Frame>() : undefined
  } catch {
    return undefined
  }
}

const REGISTRY = Symbol.for("telem.vercel.registry")
const registry: Registry = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= {
  frames: loadFrames(),
  sets: new WeakMap(),
  owners: new WeakMap(),
  turnStarts: new WeakMap(),
}) as Registry
registry.turnStarts ??= new WeakMap()
const { frames, sets, owners, turnStarts } = registry

/** The delegation moment of the step this tool call belongs to: the first
 *  sibling's start, shared by every tool call of the step. */
function turnStart(execution: TelemVercelToolExecutionOptions): string {
  const key = execution.messages
  if (typeof key !== "object" || key === null) return new Date().toISOString()
  // A loop that grows one array in place is a new step each time it grows.
  const cached = turnStarts.get(key)
  if (cached && cached.length === key.length) return cached.startedAt
  const startedAt = new Date().toISOString()
  turnStarts.set(key, { startedAt, length: key.length })
  return startedAt
}

/** Whether subagents link by themselves on this runtime: `AsyncLocalStorage`
 *  was found. When false, link them with `childTelemVercelTools`. */
export const telemVercelAutoNesting: boolean = frames !== undefined

/**
 * Create one agent: a conversation identity, the tools that carry it, and the
 * calls that attach it to a tool of the user's own. `createTelemVercelTools` is the
 * front door; this is the layer under it.
 */
export function createTelemVercelAgent(options: TelemVercelAgentOptions): TelemVercelAgent {
  const { telem, harness } = options
  if (typeof harness !== "string" || !harness) throw new TypeError("createTelemVercelAgent requires `harness`")
  const conversationId = options.conversationId ?? crypto.randomUUID()
  const ancestors: readonly TrajectorySnapshot[] = [...(options.ancestors ?? [])]
  const mode = options.incremental
  const state =
    options.incrementalState ?? createIncrementalState(mode === undefined ? {} : { mode: () => mode })
  const renderSearch = options.render?.search ?? compact
  const renderFetch = options.render?.fetch ?? page
  /** Telem calls made per tool call id, so a tool that searches several times in
   *  one call — with its options object or copies of it — gets a distinct node
   *  each time rather than one node the backend keeps the first of. Bounded like
   *  the incremental caches; an eviction only restarts a suffix. */
  const callsPerToolCall = createLruMap<number>(1024)
  function callIdFor(execution: TelemVercelToolExecutionOptions): string {
    const n = (callsPerToolCall.get(execution.toolCallId) ?? 0) + 1
    callsPerToolCall.set(execution.toolCallId, n)
    return n === 1 ? execution.toolCallId : `${execution.toolCallId}#${n}`
  }
  /** The AI SDK's abort and a per-call `signal` both cancel the request. */
  function signalFor(execution: TelemVercelToolExecutionOptions | undefined, own: AbortSignal | undefined): AbortSignal | undefined {
    const sdk = execution?.abortSignal
    if (!sdk || !own) return sdk ?? own
    return typeof AbortSignal.any === "function" ? AbortSignal.any([sdk, own]) : own
  }

  /** The identity of the calling turn, from the messages the tool was given. */
  async function turn(messages: readonly unknown[]): Promise<{ windowId: string; messageId: string }> {
    const windowId = await windowAnchor(messages as readonly Json[])
    return { windowId, messageId: await turnAnchor(messages, windowId) }
  }

  /** Everything one call sends, in opencode's order: scope → ancestors → envelope
   *  → history delta. The plan holds what the response then proves. */
  async function lineage(execution: TelemVercelToolExecutionOptions | undefined, current: TelemVercelToolCallRef) {
    const messages = execution?.messages ?? []
    const plan = newDeliveryPlan(await cacheScope(telem.baseUrl, telem.apiKey))
    // A call with no messages (outside the AI SDK loop) cannot name its epoch.
    plan.epochDegraded = execution?.messages === undefined
    const flat = telemVercelMessageHistory(messages, current)
    const { windowId, messageId } = await turn(messages)
    const planned = state.planAncestors(plan, ancestors)
    const envelope = await buildMetadata({
      harness,
      conversationId,
      windowId,
      messageId,
      toolCallId: execution ? callIdFor(execution) : crypto.randomUUID(),
      history: flat.map((message) => message.entry),
      ancestors: planned,
    })
    envelope.message_history = await state.planHistory(plan, conversationId, envelope.session_key, flat)
    return { envelope, plan }
  }

  async function search(
    query: string | string[],
    searchOptions?: SearchOptions | null,
    execution?: TelemVercelToolExecutionOptions,
  ): Promise<SearchResponse> {
    const opts: SearchOptions = { ...(searchOptions ?? {}), signal: signalFor(execution, searchOptions?.signal) }
    const { envelope, plan } = await lineage(execution, {
      name: SEARCH_TOOL,
      input: { query, goal: opts.goal, context: opts.context },
    })
    const response = await state.sendWithOmissionRetry(plan, () =>
      telem.search(query, withTrajectory(opts, envelope)),
    )
    if (isInteraction(response.raw)) state.recordDelivery(plan, response.raw)
    await notify({ kind: "search", agent, query, response })
    return response
  }

  async function fetch(
    url: string | string[],
    fetchOptions?: FetchOptions | null,
    execution?: TelemVercelToolExecutionOptions,
  ): Promise<FetchResponse> {
    const opts: FetchOptions = { ...(fetchOptions ?? {}), signal: signalFor(execution, fetchOptions?.signal) }
    const { envelope, plan } = await lineage(execution, {
      name: FETCH_TOOL,
      input: { url, goal: opts.metadata?.goal },
    })
    const response = await state.sendWithOmissionRetry(plan, () =>
      telem.fetch(url, withTrajectory(opts, envelope)),
    )
    if (isInteraction(response.raw)) state.recordDelivery(plan, response.raw)
    await notify({ kind: "fetch", agent, url, response })
    return response
  }

  /** Observation never fails a call: a throw and a rejection are both swallowed. */
  async function notify(event: TelemVercelCallEvent): Promise<void> {
    try {
      await options.onResponse?.(event)
    } catch {
      /* swallowed */
    }
  }

  async function snapshot(execution?: TelemVercelToolExecutionOptions, spawnedAt?: string): Promise<TrajectorySnapshot> {
    const messages = execution?.messages ?? []
    const { windowId, messageId } = await turn(messages)
    return await buildSnapshot({
      harness,
      conversationId,
      windowId,
      messageId,
      context: telemVercelMessageHistory(messages).map((message) => message.entry),
      ancestors,
      spawnedAt,
    })
  }

  async function child(
    execution?: TelemVercelToolExecutionOptions,
    childOptions?: { conversationId?: string; spawnedAt?: string },
  ): Promise<TelemVercelAgent> {
    return createTelemVercelAgent({
      telem,
      harness,
      conversationId: childOptions?.conversationId,
      ancestors: [...ancestors, await snapshot(execution, childOptions?.spawnedAt)],
      incremental: mode,
      render: options.render,
      onResponse: options.onResponse,
      incrementalState: state,
    })
  }

  const tools: TelemVercelAgent["tools"] = {
    telem_search: {
      description:
        "Search the public web. One query per call; returns the top results with provider, " +
        "title, url and summary. Use telem_fetch to read a page in full.",
      inputSchema: SEARCH_SCHEMA,
      execute: async (input, execution) =>
        renderSearch(await search(input.query, { goal: input.goal, context: input.context }, execution)),
    },
    telem_fetch: {
      description: "Read the text of one web page by URL. telem_search returns snippets; this returns the page.",
      inputSchema: FETCH_SCHEMA,
      execute: async (input, execution) =>
        renderFetch(
          await fetch(
            input.url,
            { inlineContent: true, inlineMaxChars: PAGE_CAP, metadata: input.goal ? { goal: input.goal } : undefined },
            execution,
          ),
        ),
    },
  }

  const agent: TelemVercelAgent = { conversationId, ancestors, telem, tools, search, fetch, snapshot, child }
  return agent
}

// --------------------------------------------------------------------------- //
// createTelemVercelTools — the tools alone are the integration. Build the set once,
// pass it to any generateText / streamText / ToolLoopAgent, and a run started
// inside one of your tools links to the tool call that started it by itself.
//
// How a nested run finds its parent: every tool in the set runs inside an
// AsyncLocalStorage frame that names the set, the run it belongs to and the call
// being made. A Telem call of the same set reads the innermost frame — the tool
// call that started the run — and hangs under it, one child conversation per
// (that tool call, the nested run's first message). A frame opened by another
// set is ignored. Without AsyncLocalStorage (a runtime without
// `process.getBuiltinModule`) the set still works as plain tools; nesting is then
// explicit through `childTelemVercelTools`.
// --------------------------------------------------------------------------- //

/** A tool as the AI SDK sees it: anything with an optional `execute`. */
export type TelemVercelToolLike = { execute?: (...args: any[]) => unknown } & Record<string, unknown>

export type TelemVercelToolsOptions<T extends Record<string, TelemVercelToolLike>> = Omit<
  TelemVercelAgentOptions,
  "incrementalState"
> & {
  /** Your own tools. Each is returned wrapped, so a run started inside it is
   *  linked. Tools without `execute` pass through untouched. */
  tools?: T
}

export type TelemVercelTools<T extends Record<string, TelemVercelToolLike>> = T & TelemVercelAgent["tools"]

/** The agent a tool call belongs to: the set's root outside any frame of this
 *  set; the frame's own agent for the tool call that opened it; otherwise the
 *  child of that frame's agent — ONE per delegating tool call, created on first
 *  use and shared by every call after. The child's identity does not depend on
 *  the nested run's messages: a compaction that rewrites the run's first message
 *  moves its window (a new session_key generation), never its conversation, the
 *  same as for the root. A tool that starts several runs shows them as one
 *  subagent with several windows; `childTelemVercelTools` with a `conversationId`
 *  keeps them apart. */
async function agentFor(entry: SetEntry, execution?: TelemVercelToolExecutionOptions): Promise<TelemVercelAgent> {
  const frame = frames?.getStore()
  if (!frame || frame.owner !== entry) return entry.root
  // The tool that opened this frame, calling on its own behalf, belongs to the
  // frame's run, not to a run started inside it. It calls with its own options
  // object or a spread copy of it, and a copy still holds the SAME `messages`
  // array; a nested run always carries an array of its own. The tool call id is
  // no discriminator: providers that number calls per response give the nested
  // run's first call the same id as the outer delegation.
  if (execution === frame.options || execution?.messages === frame.options.messages) return await frame.agent
  // The parent is in the key because provider tool call ids are not unique
  // across conversations: two roots can both see "call_1".
  const parent = await frame.agent
  const key = await contentAnchor(parent.conversationId, frame.options.toolCallId)
  let child = frame.children.get(key)
  if (!child) {
    child = parent.child(frame.options, { conversationId: key, spawnedAt: frame.startedAt })
    // A failed creation is not cached: the next call tries again.
    child.catch(() => frame.children.delete(key))
    frame.children.set(key, child)
  }
  return await child
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

/** A streaming tool's iterator runs its steps in the SDK's context, not ours, so
 *  each step is re-entered into the frame: a Telem call between two yields still
 *  finds the frame of the tool call that started its run. */
function within<T>(store: Frames, frame: Frame, source: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = store.run(frame, () => source[Symbol.asyncIterator]())
      return {
        next: (value?: unknown) => store.run(frame, () => iterator.next(value)),
        return: (value?: unknown) =>
          store.run(frame, () => iterator.return?.(value) ?? Promise.resolve({ done: true, value: value as T })),
        throw: (error?: unknown) => store.run(frame, () => iterator.throw?.(error) ?? Promise.reject(error)),
      }
    },
  }
}

function wrapTool(tool: TelemVercelToolLike, entry: SetEntry): TelemVercelToolLike {
  const execute = tool.execute
  if (typeof execute !== "function") return tool
  return {
    ...tool,
    execute(input: unknown, execution?: TelemVercelToolExecutionOptions) {
      // A call with no options (a hand call, a harness passing one argument)
      // cannot be linked to anything: run it as-is.
      if (!isObject(execution)) return execute.call(tool, input, execution)
      // Which set is running this call: what `childTelemVercelTools` and
      // `telemVercelAgentFor` resolve by, with or without a frame store.
      owners.set(execution, entry)
      if (entry.explicit || !frames) return execute.call(tool, input, execution)
      const frame: Frame = {
        owner: entry,
        // Never rejects: a frame whose run makes no Telem call never awaits it.
        agent: agentFor(entry, execution).catch(() => entry.root),
        options: execution,
        startedAt: turnStart(execution),
        children: new Map(),
      }
      // Synchronous in shape on purpose: the AI SDK decides streaming from the
      // DIRECT return value, so a generator must come back as a generator.
      const result = frames.run(frame, () => execute.call(tool, input, execution))
      return isAsyncIterable(result) ? within(frames, frame, result) : result
    },
  }
}

/**
 * Build the tool set once and pass it to every `generateText`, `streamText` or
 * `ToolLoopAgent` of one conversation. `telem_search` and `telem_fetch` carry
 * lineage on every call; a run started inside any tool in the set — a subagent —
 * links to the tool call that started it, with nothing else to write.
 *
 * Build it where the conversation starts, once per conversation: a set shared
 * by several conversations records them as one.
 *
 * @example
 * ```ts
 * // `delegate` is a tool of yours whose execute starts another generateText with the same `tools`.
 * const tools = createTelemVercelTools({ telem, harness: "my-app", tools: { delegate } })
 * await generateText({ model, tools, prompt })
 * ```
 */
export function createTelemVercelTools<T extends Record<string, TelemVercelToolLike> = {}>(
  options: TelemVercelToolsOptions<T>,
): TelemVercelTools<T> {
  const { tools: own, ...agentOptions } = options
  return buildSet(createTelemVercelAgent(agentOptions), own, false) as TelemVercelTools<T>
}

/** The set a call belongs to: the one whose tool is running with these
 *  options, else the set the caller handed over. */
function entryFor(tools: object, execution: TelemVercelToolExecutionOptions | undefined, who: string): SetEntry {
  const entry = (isObject(execution) ? owners.get(execution) : undefined) ?? sets.get(tools)
  if (!entry) {
    throw new TypeError(`${who}: pass the set that createTelemVercelTools returned, not a copy of it`)
  }
  return entry
}

/**
 * The tool set for a subagent, linked to the tool call that starts it, by hand.
 * For a runtime without `AsyncLocalStorage` (`telemVercelAutoNesting` is false), or to name
 * the child's conversation. Inside the tool that starts the subagent:
 * `const subTools = await childTelemVercelTools(tools, options)`, then pass `subTools`
 * to the subagent's generateText. The set is bound to the child outright, and the
 * same line works one level down: the set knows which tool call it runs in.
 */
export async function childTelemVercelTools<T extends Record<string, TelemVercelToolLike>>(
  tools: TelemVercelTools<T>,
  execution: TelemVercelToolExecutionOptions,
  options?: { conversationId?: string },
): Promise<TelemVercelTools<T>> {
  const entry = entryFor(tools, execution, "childTelemVercelTools")
  const parent = entry.explicit ? entry.root : await agentFor(entry, execution)
  const child = await parent.child(execution, { ...options, spawnedAt: turnStart(execution) })
  return buildSet(child, entry.own, true) as TelemVercelTools<T>
}

function buildSet(
  root: TelemVercelAgent,
  own: Record<string, TelemVercelToolLike> | undefined,
  explicit: boolean,
): TelemVercelTools<Record<string, TelemVercelToolLike>> {
  const entry: SetEntry = { root, own, explicit }
  const resolve = explicit ? async () => root : (execution?: TelemVercelToolExecutionOptions) => agentFor(entry, execution)
  const set: Record<string, unknown> = {
    telem_search: {
      ...root.tools.telem_search,
      execute: async (input: TelemVercelSearchInput, execution: TelemVercelToolExecutionOptions) =>
        (await resolve(execution)).tools.telem_search.execute(input, execution),
    },
    telem_fetch: {
      ...root.tools.telem_fetch,
      execute: async (input: TelemVercelFetchInput, execution: TelemVercelToolExecutionOptions) =>
        (await resolve(execution)).tools.telem_fetch.execute(input, execution),
    },
  }
  for (const [name, tool] of Object.entries(own ?? {})) {
    if (name === SEARCH_TOOL || name === FETCH_TOOL) {
      throw new TypeError(`createTelemVercelTools: \`${name}\` is the Telem tool's own name; use \`render\` to change what it returns`)
    }
    set[name] = wrapTool(tool, entry)
  }
  sets.set(set, entry)
  return set as TelemVercelTools<Record<string, TelemVercelToolLike>>
}

/**
 * The agent a tool call belongs to, for a tool of your own that calls Telem:
 * `const agent = await telemVercelAgentFor(tools, options); agent.search(query, {}, options)`.
 * The root agent outside any run started by a tool; the linked child inside one.
 */
export async function telemVercelAgentFor(tools: object, execution?: TelemVercelToolExecutionOptions): Promise<TelemVercelAgent> {
  const entry = entryFor(tools, execution, "telemVercelAgentFor")
  return entry.explicit ? entry.root : await agentFor(entry, execution)
}

/** `require("@telemai/sdk/vercel")` is `createTelemVercelAgent`, the way the main entry's
 *  `require` is the client class: the CJS build hangs the named exports off the
 *  default (tsup footer), so the default must exist for the module to load. */
export default createTelemVercelAgent
