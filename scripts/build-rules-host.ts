import { build } from "esbuild";

// The host imports only this prebuilt runtime as source, never executes it in Node.
await build({
  entryPoints: ["packages/rules/src/index.ts"],
  outfile: "packages/rules-host/dist/runtime-bundle.js",
  bundle: true,
  format: "iife",
  globalName: "BGP_RUNTIME",
  platform: "neutral",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  conditions: ["import"],
});

await build({
  entryPoints: ["packages/rules-host/spike/vm-worker.ts"],
  outfile: "packages/rules-host/dist/spike-vm-worker.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
});
