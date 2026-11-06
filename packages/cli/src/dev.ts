import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  componentAssetRefs,
  DEV_SERVER_PROTOCOL,
  type DevGameResponse,
  imageTypeFor,
  type ValidationError,
  VersionPathSchema,
} from "@bgp/schema";
import { bundleGame } from "./build.js";
import { type GamePackage, loadGamePackage, PackageError } from "./game-package.js";

// `bgp dev`: rebuilds the game whenever a file in the package changes and serves the result
// to the web app's /dev hot-seat page (docs/contracts/dev-server.md).

export const DEFAULT_DEV_PORT = 4400;
export const DEFAULT_WEB_ORIGIN = "http://localhost:5173";

export interface DevOptions {
  port: number;
  /** Origin of the web app; the only origin allowed to read responses. */
  webOrigin: string;
  /** Called after each rebuild, for the terminal. */
  onBuild?(game: DevGameResponse): void;
}

export interface DevServer {
  /** The server's origin, e.g. http://127.0.0.1:4400. */
  origin: string;
  /** The page to open in the web app. */
  pageUrl: string;
  current(): DevGameResponse;
  /** Rebuilds now (file changes call this too). */
  rebuild(): Promise<DevGameResponse>;
  close(): Promise<void>;
}

/** Files that never trigger a rebuild: build output and installed packages. */
const IGNORED = /(^|[\\/])(dist|node_modules|\.git)([\\/]|$)/;
const DEBOUNCE_MS = 80;
const PING_MS = 15_000;

function contentType(path: string): string {
  return (
    imageTypeFor(path) ?? (path.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream")
  );
}

/** One build: the package as it is on disk now, falling back to the last good package. */
async function buildOnce(
  dir: string,
  previous: GamePackage | null,
  buildId: number,
): Promise<{ pkg: GamePackage | null; game: DevGameResponse | null; errors: ValidationError[] }> {
  let pkg: GamePackage;
  try {
    pkg = await loadGamePackage(dir);
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    const errors =
      error.errors.length > 0 ? [...error.errors] : [{ path: "", message: error.message }];
    if (!previous) return { pkg: null, game: null, errors };
    const game: DevGameResponse = {
      protocol: DEV_SERVER_PROTOCOL,
      buildId,
      manifest: previous.manifest,
      components: previous.components,
      source: null,
      errors,
    };
    return { pkg: previous, game, errors };
  }
  let source: string | null = null;
  let errors: ValidationError[] = [];
  if (pkg.manifest.mode === "enforced") {
    try {
      source = (await bundleGame(pkg)).source;
    } catch (error) {
      if (!(error instanceof PackageError)) throw error;
      errors = [...error.errors];
    }
  }
  const game: DevGameResponse = {
    protocol: DEV_SERVER_PROTOCOL,
    buildId,
    manifest: pkg.manifest,
    components: pkg.components,
    source,
    errors,
  };
  return { pkg, game, errors };
}

/** Starts `bgp dev` for the package in `dir`. Fails if the package cannot be loaded at all. */
export async function startDevServer(dir: string, options: DevOptions): Promise<DevServer> {
  let buildId = 0;
  const first = await buildOnce(dir, null, buildId);
  if (!first.pkg || !first.game)
    throw new PackageError("The package cannot be loaded", first.errors);
  let pkg = first.pkg;
  let game = first.game;
  const clients = new Set<ServerResponse>();

  const cors = (response: ServerResponse) => {
    response.setHeader("access-control-allow-origin", options.webOrigin);
    response.setHeader("vary", "origin");
    response.setHeader("x-content-type-options", "nosniff");
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    cors(response);
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (path === "/game") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(game));
      return;
    }
    if (path === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    // Only files the components reference; nothing else in the package is served.
    const ref = path.slice(1);
    const refs = new Set(componentAssetRefs(pkg.components));
    if (!refs.has(ref) || !VersionPathSchema.safeParse(ref).success) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(join(pkg.dir, ref));
      response.writeHead(200, { "content-type": contentType(ref), "cache-control": "no-cache" });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404).end();
    }
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  let building: Promise<DevGameResponse> | null = null;
  let again = false;
  async function rebuild(): Promise<DevGameResponse> {
    if (building) {
      again = true;
      return building;
    }
    building = (async () => {
      do {
        again = false;
        buildId += 1;
        const next = await buildOnce(dir, pkg, buildId);
        if (next.pkg) pkg = next.pkg;
        if (next.game) game = next.game;
      } while (again);
      const data = JSON.stringify({ buildId: game.buildId });
      for (const client of clients) client.write(`event: build\ndata: ${data}\n\n`);
      options.onBuild?.(game);
      return game;
    })();
    try {
      return await building;
    } finally {
      building = null;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, file) => {
    if (file !== null && IGNORED.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), DEBOUNCE_MS);
  });
  const ping = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, PING_MS);
  options.onBuild?.(game);

  return {
    origin,
    pageUrl: `${options.webOrigin}/dev?game=${encodeURIComponent(origin)}`,
    current: () => game,
    rebuild,
    async close() {
      clearTimeout(timer);
      clearInterval(ping);
      watcher.close();
      for (const client of clients) client.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
