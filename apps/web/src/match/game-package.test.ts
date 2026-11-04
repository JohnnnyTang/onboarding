import type { VersionResponse } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import type { ApiClient, TokenScope } from "../api/client";
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
  const unused = () => Promise.reject(new Error("unused"));
  const api: ApiClient = {
    listGames: unused,
    getGame: unused,
    listMatches: unused,
    getMatch: unused,
    claimInvite: unused,
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
  };
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
    expect(pkg.source).toBe("export default {};");
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

  test("refuses sandbox versions, which the room server does not host yet", async () => {
    const { api } = fakeApi(files(), {
      manifest: { ...manifest, mode: "sandbox", entry: undefined } as never,
    });
    await expect(loadGamePackage(api, "v1", "m1", fakeUrls())).rejects.toMatchObject({
      reason: "sandbox",
    });
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
