import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RulesHostClient } from "@bgp/rules-host";
import { type ComponentsFile, componentAssetRefs, type Manifest } from "@bgp/schema";
import type { FastifyInstance, HTTPMethods, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/auth/service.js";
import { createUserStore } from "../src/auth/user-store.js";
import { type BlobStore, createFsBlobStore } from "../src/blob/blob-store.js";
import { connectDatabase, type Database, type DatabaseConnection } from "../src/db/connection.js";
import type { SetupChecker } from "../src/versions/finalize.js";
import { createRulesSetupChecker, createVersionBuildStore } from "../src/versions/rules-builds.js";
import { startIssuer, TEST_SECRET } from "./auth-fixture.js";
import { testDatabaseUrl } from "./database.js";

export const WEB_ORIGIN = "http://web.example.test";
/** A real 1×1 PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

export const passingSetup: SetupChecker = { check: async () => [] };

export interface Harness {
  connection: DatabaseConnection;
  issuer: Awaited<ReturnType<typeof startIssuer>>;
  blobs: BlobStore;
  blobDir: string;
  /** Real rules host for finalize setup checks (enforced games). */
  rulesSetup(): SetupChecker;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const connection = connectDatabase(testDatabaseUrl());
  const issuer = await startIssuer();
  const blobDir = await mkdtemp(join(tmpdir(), "bgp-blobs-"));
  const blobs = createFsBlobStore(blobDir);
  // One store per host: the host resolves builds through the store it was created with.
  const builds = createVersionBuildStore(connection.db, blobs);
  let host: RulesHostClient | undefined;
  return {
    connection,
    issuer,
    blobs,
    blobDir,
    rulesSetup() {
      host ??= new RulesHostClient(builds, { warmSpareCount: 0, idleTimeoutMs: 0 });
      return createRulesSetupChecker(host, builds);
    },
    async close() {
      host?.close();
      await issuer.close();
      await connection.close();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

type Options = {
  token?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
};
export interface Api {
  app: FastifyInstance;
  db: Database;
  call(method: HTTPMethods, url: string, options?: Options): Promise<LightMyRequestResponse>;
  designer(sub?: string): Promise<string>;
}

/** Runs one test against an app whose database work is rolled back afterwards. */
export async function withApi(
  harness: Harness,
  run: (api: Api) => Promise<void>,
  setup: SetupChecker = passingSetup,
): Promise<void> {
  const rollback = new Error("rollback API fixture");
  try {
    await harness.connection.db.transaction(async (tx) => {
      const app = await buildApp({
        db: tx,
        auth: createAuthService({
          oidc: harness.issuer.oidc,
          guestTokenSecret: TEST_SECRET,
          users: createUserStore(tx),
        }),
        blobs: harness.blobs,
        setup,
        publicWebOrigin: WEB_ORIGIN,
      });
      try {
        await run({
          app,
          db: tx,
          call(method, url, { token, body, headers } = {}) {
            return app.inject({
              method,
              url,
              headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
              ...(body === undefined
                ? {}
                : Buffer.isBuffer(body)
                  ? { payload: body }
                  : { payload: body as object }),
            });
          },
          designer: (sub = "designer-1") => harness.issuer.token({ sub, name: sub }),
        });
      } finally {
        await app.close();
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

export interface Package {
  manifest: Manifest;
  files: Record<string, Buffer>;
}

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** Harbor Market as `bgp publish` would upload it, with placeholder card art. */
export async function harborMarket(): Promise<Package> {
  const manifest = JSON.parse(await readFile(root("games/harbor-market/bgp.json"), "utf8"));
  const componentsText = await readFile(root("games/harbor-market/components.json"));
  const components = JSON.parse(componentsText.toString("utf8")) as ComponentsFile;
  const files: Record<string, Buffer> = {
    "components.json": componentsText,
    "dist/game.js": await readFile(root("games/harbor-market/dist/game.js")),
  };
  for (const ref of componentAssetRefs(components)) files[ref] = PNG;
  return { manifest, files };
}

export function sandboxPackage(slug = "sandbox-test", version = "0.1.0"): Package {
  const components: ComponentsFile = {
    schemaVersion: 1,
    defs: [
      { id: "back", kind: "cardBack", image: "assets/back.png" },
      { id: "fish", kind: "card", size_mm: [63, 88], front: "assets/fish.png", back: "back" },
    ],
    zones: [
      {
        id: "deck",
        layout: "stack",
        rect_mm: { x: 0, y: 0, w: 100, h: 100 },
        visibility: "public",
      },
      {
        id: "hand",
        layout: "fan",
        rect_mm: { x: 0, y: -150, w: 200, h: 100 },
        visibility: "owner",
        owner: "each",
      },
    ],
    setup: { instances: [{ def: "fish", zone: "deck", count: 4, face: "down" }] },
  };
  return {
    manifest: {
      schemaVersion: 1,
      id: slug,
      name: "Sandbox Test",
      version,
      mode: "sandbox",
      sdk: 1,
      players: { min: 1, max: 4 },
      components: "components.json",
      options: [{ id: "variant", label: "Variant", type: "boolean", default: false }],
    },
    files: {
      "components.json": Buffer.from(JSON.stringify(components)),
      "assets/back.png": PNG,
      "assets/fish.png": PNG,
    },
  };
}

export async function createGame(api: Api, token: string, slug: string): Promise<string> {
  const response = await api.call("POST", "/api/games", {
    token,
    body: { slug, name: slug, visibility: "unlisted" },
  });
  if (response.statusCode !== 201) throw new Error(`create game: ${response.body}`);
  return response.json().id;
}

export async function createDraft(api: Api, token: string, gameId: string, manifest: Manifest) {
  const response = await api.call("POST", `/api/games/${gameId}/versions`, {
    token,
    body: manifest,
  });
  if (response.statusCode !== 201) throw new Error(`create version: ${response.body}`);
  return response.json().id as string;
}

export function upload(
  api: Api,
  token: string,
  versionId: string,
  path: string,
  bytes: Buffer,
  hash = sha256(bytes),
) {
  return api.call("PUT", `/api/versions/${versionId}/files/${path}`, {
    token,
    body: bytes,
    headers: { "x-content-sha256": hash, "content-type": "application/octet-stream" },
  });
}

export async function uploadAll(
  api: Api,
  token: string,
  versionId: string,
  files: Package["files"],
) {
  for (const [path, bytes] of Object.entries(files)) {
    const response = await upload(api, token, versionId, path, bytes);
    if (response.statusCode !== 204) throw new Error(`upload ${path}: ${response.body}`);
  }
}

export function finalize(api: Api, token: string, versionId: string) {
  return api.call("POST", `/api/versions/${versionId}/finalize`, { token, body: {} });
}

/** Creates (or reuses) the game, uploads every file and finalizes. */
export async function publish(api: Api, token: string, pkg: Package, gameId?: string) {
  const game = gameId ?? (await createGame(api, token, pkg.manifest.id));
  const versionId = await createDraft(api, token, game, pkg.manifest);
  await uploadAll(api, token, versionId, pkg.files);
  const response = await finalize(api, token, versionId);
  return { gameId: game, versionId, response };
}
