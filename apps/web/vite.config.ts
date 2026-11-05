import { createHash } from "node:crypto";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const SERVICE_WORKER = "sw.js";

/**
 * Fills the service worker's precache list (src/service-worker.ts) with every file of the
 * build, and its version with a hash of their contents, so a new build replaces the cache.
 */
function precacheManifest(): Plugin {
  return {
    name: "bgp-precache-manifest",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const files = Object.keys(bundle)
          .filter((name) => name !== SERVICE_WORKER && !name.endsWith(".map"))
          .sort();
        const hash = createHash("sha256");
        for (const name of files) {
          const output = bundle[name];
          if (!output) continue;
          hash.update(`${name}\n`);
          hash.update(output.type === "chunk" ? output.code : output.source);
        }
        const worker = bundle[SERVICE_WORKER];
        if (worker?.type !== "chunk") throw new Error("The service worker was not built");
        const paths = files.map((name) => `/${name}`);
        // The worker parses this string literal; escape it as JSON inside a JS string.
        worker.code = worker.code
          .replace("__BGP_PRECACHE_MANIFEST__", JSON.stringify(JSON.stringify(paths)).slice(1, -1))
          .replace("__BGP_PRECACHE_VERSION__", hash.digest("hex").slice(0, 16));
        if (worker.code.includes("__BGP_PRECACHE_") || /\bimport\b[\s{*"']/.test(worker.code)) {
          throw new Error("The service worker must be one self-contained script");
        }
      },
    },
  };
}

// The Keycloak client allows redirects to http://localhost:5173 only (infra/keycloak).
export default defineConfig({
  plugins: [react(), precacheManifest()],
  server: { host: "localhost", port: 5173, strictPort: true },
  preview: { host: "localhost", port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    sourcemap: true,
    rolldownOptions: {
      input: { index: "index.html", sw: "src/service-worker.ts" },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? SERVICE_WORKER : "assets/[name]-[hash].js",
      },
    },
  },
});
