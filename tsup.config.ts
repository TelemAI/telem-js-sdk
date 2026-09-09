import { defineConfig } from "tsup"

// Dual ESM/CJS build with declarations, matching the exports map in package.json
// (types/import/require). `node18` because the transport is the platform `fetch`.
export default defineConfig({
  entry: ["src/index.ts", "src/vercel/index.ts"],
  format: ["esm", "cjs"],
  target: "node18",
  dts: true,
  clean: true,
  // Nothing to bundle in — the package has no runtime dependencies — but bundling
  // keeps the published tree to one file per format instead of mirroring src/. No
  // tree-shake pass: it re-emits the CJS export assignments after the footer below,
  // which must run last.
  treeshake: false,
  // `require("@telemai/sdk")` is the client class, the way `import Telem from "@telemai/sdk"`
  // is: the CJS bundle exports `default` plus the named exports, so the footer makes
  // the class the module and hangs the named exports off it. its own suite pins it.
  footer: ({ format }) =>
    format === "cjs" ? { js: "module.exports = Object.assign(module.exports.default, module.exports);" } : {},
})
