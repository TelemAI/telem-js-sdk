// The client on its own: search, search several queries at once, read a page.
// No agent framework, no lineage. Calls that belong together share a session id.
//
//   npm run build            # the example imports the built package
//   export TELEM_API_KEY=...
//   node examples/search.mjs
import Telem from "@telemai/sdk"

const telem = new Telem() // TELEM_API_KEY from the environment

// One query. `goal` is recorded with the call and shown in the console.
const search = await telem.search("Nintendo Museum Kyoto New Year closures 2026", {
  goal: "closure dates",
  numResults: 5,
})
console.log(`session ${search.sessionId}`)
for (const result of search.results) console.log(`[${result.provider}] ${result.title} — ${result.url}`)

// Several queries in one call. Pass the session id back so the calls stay together.
const batch = await telem.search(
  ["Super Nintendo World New Year opening hours", "Pokemon Center Osaka holiday hours"],
  { session: search.sessionId },
)
for (const run of batch.byProvider) console.log(`${run.query}: ${run.results.length} results from ${run.provider}`)

// Read one page in full, on the same session.
const page = await telem.fetch(search.results[0].url, {
  session: search.sessionId,
  inlineContent: true,
  inlineMaxChars: 600,
})
console.log(`\n${page.results[0].url}\n${page.results[0].content}`)
