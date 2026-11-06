import { build } from "esbuild";

// `bgp validate` runs game bundles in this worker. Like the rules host's runtime bundle, it
// carries the runtime built for production, so immer never reads `process` (which the
// worker locks) while game code mutates a draft.
await build({
  entryPoints: ["packages/cli/src/check-worker.ts"],
  // Separate from tsc's unbundled dist/check-worker.js.
  outfile: "packages/cli/dist/validate-worker.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  define: { "process.env.NODE_ENV": '"production"' },
  conditions: ["import"],
  logLevel: "warning",
});
