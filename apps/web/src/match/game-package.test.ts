import type { VersionResponse } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import type { ApiClient, TokenScope } from "../api/client";
import { fakeApi as fakeApiClient } from "../test/fake-api";
import { GamePackageError, loadGamePackage, MAX_BUNDLE_BYTES } from "./game-package";

const HASH = "c".repeat(64);
const COMPONENTS = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "fish", kind: "card", size_mm: [63, 88], front: "assets/fish.png", back: "back" },
    { id: "boat", kind: "piece", size_mm: [10, 10, 10], image: "assets/boat.png", model: "b.glb" },
  ],
};
const manifest = {
  schemaVersion: 1,
  id: "fish-game",
  name: "Fish",
  version: "1.0.0",
  mode: "enforced",
  sdk: 1,
  players: { min: 1, max: 2 },
  entry: "dist/game.js",
  components: "components.json",
} as const;

function fakeApi(files: Record<string, Blob>, version: Partial<VersionResponse> = {}) {
  const requests: { path: string; scope: TokenScope | undefined }[] = [];
  const api: ApiClient = fakeApiClient({
    getVersion: async (id, scope) => {
      requests.push({ path: "version", scope });
      return {
        id,
        gameId: "g",
        manifest,
        status: "ready",
        buildHash: HASH,
        validationErrors: null,
        ...version,
      } as VersionResponse;
    },
    getVersionFile: async (_id, path, scope) => {
      requests.push({ path, scope });
      const file = files[path];
      if (!file) throw new Error("missing");
      return file;
    },
  });
  return { api, requests };
}

function fakeUrls() {
  const revoked: string[] = [];
  let next = 0;
  return {
    revoked,
    createObjectURL: () => {
      next += 1;
      return `blob:test/${next}`;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  };
}

const files = (overrides: Record<string, Blob> = {}) => ({
  "components.json": new Blob([JSON.stringify(COMPONENTS)]),
  "dist/game.js": new Blob(["export default {};"]),
  "assets/back.png": new Blob(["png"]),
  ...overrides,
});

describe("game package", () => {
  test("loads the manifest, components, bundle and images for one match", async () => {
    const { api, requests } = fakeApi(files());
    const urls = fakeUrls();
    const pkg = await loadGamePackage(api, "v1", "m1", urls);
    expect(pkg.game).toEqual({ kind: "bundle", source: "export default {};" });
    expect(pkg.components.defs).toHaveLength(3);
    expect(pkg.assetUrl("assets/back.png")).toMatch(/^blob:test\//);
    // A missing image becomes placeholder art; models are not fetched in 2D.
    expect(pkg.assetUrl("assets/fish.png")).toBe("");
    expect(requests.map((request) => request.path)).not.toContain("b.glb");
    expect(requests.every((request) => request.scope?.matchId === "m1")).toBe(true);
    pkg.dispose();
    expect(urls.revoked).toEqual(["blob:test/1"]);
    expect(pkg.assetUrl("assets/back.png")).toBe("");
  });

  test("runs sandbox versions with the built-in definition and downloads no bundle", async () => {
    const { entry: _entry, ...rest } = manifest;
    const sandbox = {
      ...COMPONENTS,
      defs: COMPONENTS.defs.slice(0, 2),
      zones: [],
      setup: { instances: [] },
    };
    const { api, requests } = fakeApi(
      files({ "components.json": new Blob([JSON.stringify(sandbox)]) }),
      { manifest: { ...rest, mode: "sandbox" } as never },
    );
    const pkg = await loadGamePackage(api, "v1", "m1", fakeUrls());
    expect(pkg.game).toEqual({ kind: "sandbox" });
    expect(requests.map((request) => request.path)).not.toContain("dist/game.js");
    // A sandbox components file must declare zones and setup.
    const { api: bare } = fakeApi(files(), { manifest: { ...rest, mode: "sandbox" } as never });
    await expect(loadGamePackage(bare, "v1", "m1", fakeUrls())).rejects.toBeInstanceOf(
      GamePackageError,
    );
  });

  test("refuses invalid components and oversized bundles", async () => {
    for (const overrides of [
      { "components.json": new Blob(["not json"]) },
      { "components.json": new Blob([JSON.stringify({ schemaVersion: 2, defs: [] })]) },
      { "dist/game.js": new Blob([new Uint8Array(MAX_BUNDLE_BYTES + 1)]) },
    ]) {
      const { api } = fakeApi(files(overrides));
      await expect(loadGamePackage(api, "v1", "m1", fakeUrls())).rejects.toBeInstanceOf(
        GamePackageError,
      );
    }
  });
});
