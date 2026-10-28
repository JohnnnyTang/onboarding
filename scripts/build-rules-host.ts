import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

await build({
  entryPoints: ["packages/rules-host/src/host-worker.ts"],
  // Keep this separate from tsc's unbundled dist/host-worker.js. Turbo can build
  // dependencies while a package test prepares its worker distribution.
  outfile: "packages/rules-host/dist/host-entry.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  minify: true,
  banner: {
    js: 'import { createRequire as hostCreateRequire } from "node:module"; const require = hostCreateRequire(import.meta.url);',
  },
});
const require = createRequire(new URL("../packages/rules-host/package.json", import.meta.url));
await copyFile(
  require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
  "packages/rules-host/dist/quickjs.wasm",
);
