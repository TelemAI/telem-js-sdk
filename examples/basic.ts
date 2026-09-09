// The three methods, end to end, against a real deployment.
//
//   cp .env.example .env && $EDITOR .env
//   node --env-file=.env examples/basic.ts
//
// With no key at all it still runs: the client falls back to the hosted deployment
// anonymously, or to ~/.telem/credentials.json if the guided installer wrote one.
//
// (In your own project, import from "@telemai/sdk" instead of "./src/index.ts".)

import Telem, { TelemError, TimeoutError } from "../src/index.ts"

const telem = new Telem()
console.log(`talking to ${telem.baseUrl}${telem.apiKey ? " with a key" : " anonymously"}\n`)

try {
  // 1. Which providers can this deployment run?
  const providers = await telem.providers()
  console.log("providers:", providers.map((provider) => provider.name).join(", "), "\n")

  // 2. Search. Options are per call; anything omitted falls through to the client
  //    default, then to the server's own.
  const search = await telem.search("typescript structural typing", {
    tier: "extended",
    numResults: 3,
    goal: "show what the SDK returns",
  })
  console.log(`search: ${search.status} (session ${search.sessionId})`)
  for (const result of search.results) {
    console.log(`  [${result.provider}] ${result.title || "(untitled)"} — ${result.url}`)
  }

  // byProvider keeps partial failures: one provider timing out never costs you the rest.
  for (const run of search.byProvider) {
    if (run.error) console.log(`  ! ${run.provider} failed: ${JSON.stringify(run.error)}`)
  }

  // 3. Fetch the first result's page, on the same session.
  const first = search.results[0]
  if (first) {
    const fetched = await telem.fetch(first.url, {
      inlineContent: true,
      inlineMaxChars: 500,
      session: search.sessionId,
    })
    for (const page of fetched.results) {
      console.log(`\nfetch: ${page.status} ${page.url}`)
      console.log((page.content ?? "").slice(0, 300))
    }
  }
} catch (error) {
  // Exactly two error classes; branch on status/code, never on message text.
  if (error instanceof TimeoutError) {
    console.error(`timed out after ${telem.timeoutMs}ms`)
  } else if (error instanceof TelemError) {
    console.error(`telem error: status=${error.status} code=${error.code} — ${error.message}`)
  } else {
    throw error
  }
  process.exitCode = 1
}
