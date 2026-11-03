// A monitor: Telem runs a query on a schedule, and its agent checks every result
// against the query and keeps the ones that match. Read what it finds as a list of
// changes, oldest first.
//
//   npm run build            # the example imports the built package
//   export TELEM_API_KEY=...
//   node examples/monitor.mjs
import Telem from "@telemai/sdk"

const telem = new Telem() // TELEM_API_KEY from the environment

// A monitor with an agent must end: ttl is at most 30 days.
const monitor = await telem.monitors.create("Nvidia files a new 8-K with the SEC", {
  frequency: "1d",
  ttl: "7d",
})
console.log(`monitor ${monitor.id}`)

if (monitor.agentState) {
  console.log(`agent ${monitor.agentState.status}`) // compiling while it makes its plan

  // What the agent found so far. Keep the seq of the last change, and read on from it later.
  let saved = 0
  for await (const change of telem.monitors.iterateChanges(monitor.id, { cursor: saved })) {
    console.log(change.seq, change.kind, change.subject.name)
    saved = change.seq
  }

  const agent = await telem.monitors.agent(monitor.id)
  console.log(`agent ${agent.status}, plan version ${agent.specVersion}`)
} else {
  // The monitor stands without its agent, and the create's answer says why.
  console.log(`no agent: ${monitor.agentNote}`)
}

await telem.monitors.delete(monitor.id)
