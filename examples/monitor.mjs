// A monitor: Telem runs a query on a schedule, and each poll returns only
// the results that are new since the last poll.
//
//   npm run build            # the example imports the built package
//   export TELEM_API_KEY=...
//   node examples/monitor.mjs
import Telem from "@telemai/sdk"

const telem = new Telem() // TELEM_API_KEY from the environment

const monitor = await telem.monitors.create("Nvidia files a new 8-K with the SEC", {
  frequency: "1d",
})
console.log(`monitor ${monitor.id}`)

// Poll as frequently as you need.
const response = await telem.monitors.poll(monitor.id)
for (const result of response.results) console.log(`${result.title} — ${result.url}`)

await telem.monitors.delete(monitor.id)
