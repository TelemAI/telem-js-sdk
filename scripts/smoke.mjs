// The public check: the package builds and both entry points import with their
// public surface intact. `npm run build` has already run by the time CI calls this.
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const sdk = await import("../dist/index.js")
assert.equal(typeof sdk.default, "function", "dist/index.js must export the Telem client as default")
assert.equal(typeof sdk.buildMetadata, "function", "dist/index.js must export buildMetadata")
assert.equal(typeof sdk.toolMarker, "function", "dist/index.js must export toolMarker")

const vercel = await import("../dist/vercel/index.js")
assert.equal(typeof vercel.createTelemVercelTools, "function", "dist/vercel/index.js must export createTelemVercelTools")

const require = createRequire(import.meta.url)
assert.equal(typeof require("../dist/index.cjs"), "function", "dist/index.cjs must be the Telem client")
assert.equal(typeof require("../dist/vercel/index.cjs").createTelemVercelTools, "function", "dist/vercel/index.cjs must export createTelemVercelTools")
console.log("ok: @telemai/sdk exports Telem, buildMetadata, toolMarker; @telemai/sdk/vercel exports createTelemVercelTools")
