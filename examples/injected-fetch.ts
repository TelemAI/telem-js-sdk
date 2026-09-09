// The injectable transport — the reason this SDK has no HTTP dependency.
//
//   node examples/injected-fetch.ts
//
// No key and no network: the whole example runs against a fake `fetch`. That is the
// same seam an embedder uses to route requests through its own client, an edge worker
// uses to supply the runtime's `fetch`, and a test suite uses to script responses.
//
// (In your own project, import from "@telemai/sdk" instead of "./src/index.ts".)

import Telem from "../src/index.ts"

// A transport that logs every request and answers from a canned body.
const canned = {
  session_id: "33333333-3333-3333-3333-333333333333",
  interaction_id: "44444444-4444-4444-4444-444444444444",
  status: "succeeded",
  normalized_schema_version: 2,
  preprocessor_runs: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      preprocessor_name: "exa",
      status: "succeeded",
      batch_index: 0,
      query: "offline query",
      latency_ms: 12,
      output_payload: {
        schema_version: 2,
        tier: "default",
        fields: ["url", "title", "summary"],
        results: [
          { url: "https://example.com/a", title: "First", summary: "…", rank: 1 },
          { url: "https://example.com/b", title: null, summary: null, rank: 2 },
        ],
      },
    },
  ],
}

const telem = new Telem({
  apiKey: "tlm_not_a_real_key",
  baseUrl: "https://router.example",
  fetch: async (input, init) => {
    console.log(`-> ${init?.method ?? "GET"} ${String(input)}`)
    console.log(`   ${init?.body ?? "(no body)"}`)
    return new Response(JSON.stringify(canned), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
})

const response = await telem.search("offline query", { tier: "default", numResults: 2 })

console.log(`\n<- ${response.status}, ${response.results.length} results`)
for (const result of response.results) {
  // A null title is coerced to ""; nothing else is. `raw` keeps the server's own row.
  console.log(`   ${JSON.stringify(result.title)} ${result.url} (rank ${result.rank})`)
}
