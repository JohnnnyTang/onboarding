import { createHash } from "node:crypto";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { loadWebConfig, type WebConfig } from "./src/config";
import {
  contentSecurityPolicy,
  GAME_WORKER_POLICY,
  GAME_WORKER_SCRIPT,
} from "./src/security/content-security-policy";

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

/**
 * The content security policy (src/security/content-security-policy.ts) for production
 * builds: a `<meta>` tag first in `index.html`, so any static host enforces it, and the full
 * header from `vite preview`, which also gives the game worker its own stricter policy.
 * Development (`vite dev`) has none: React Refresh needs an inline script.
 */
function contentSecurityPolicyPlugin(): Plugin {
  let config: WebConfig | undefined;
  const resolved = () => {
    if (!config) throw new Error("Vite config not resolved");
    return config;
  };
  return {
    name: "bgp-content-security-policy",
    configResolved(resolvedConfig) {
      config = loadWebConfig(resolvedConfig.env);
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (context.server) return html;
        // Right after the charset, before any script or stylesheet it governs.
        const charset = '<meta charset="utf-8" />';
        if (!html.includes(charset)) throw new Error("index.html must declare its charset");
        const policy = contentSecurityPolicy(resolved(), "meta").replaceAll("'", "&#39;");
        return html.replace(
          charset,
          `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        );
      },
    },
    configurePreviewServer(server) {
      const page = contentSecurityPolicy(resolved(), "header");
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? "/", "http://preview").pathname;
        response.setHeader(
          "Content-Security-Policy",
          GAME_WORKER_SCRIPT.test(path) ? GAME_WORKER_POLICY : page,
        );
        next();
      });
    },
  };
}

// The Keycloak client allows redirects to http://localhost:5173 only (infra/keycloak).
export default defineConfig({
  plugins: [react(), precacheManifest(), contentSecurityPolicyPlugin()],
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
