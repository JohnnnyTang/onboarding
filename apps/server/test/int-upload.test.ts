import { HttpErrorSchema, VersionResponseSchema } from "@bgp/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Api,
  createDraft,
  createGame,
  finalize,
  type Harness,
  harborMarket,
  PNG,
  publish,
  sandboxPackage,
  sha256,
  startHarness,
  upload,
  uploadAll,
  withApi,
} from "./api-fixture.js";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness?.close();
});

const withRules = (run: (api: Api) => Promise<void>) => withApi(harness, run, harness.rulesSetup());

function errorsOf(response: { json(): unknown }) {
  return HttpErrorSchema.parse(response.json()).error;
}

/** The manifest.md build hash, computed independently of the server code. */
function expectedBuildHash(files: Record<string, Buffer>): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map((path) => `${path}\t${sha256(files[path] ?? Buffer.alloc(0))}\n`)
      .join(""),
  );
}

describe("INT-UPLOAD", () => {
  it("finalizes Harbor Market and gives identical files the same build hash", async () => {
    await withRules(async (api) => {
      const token = await api.designer();
      const pkg = await harborMarket();
      const first = await publish(api, token, pkg);
      expect(first.response.statusCode, first.response.body).toBe(200);
      const buildHash = first.response.json().buildHash;
      expect(buildHash).toBe(expectedBuildHash(pkg.files));

      const again = await publish(
        api,
        token,
        { ...pkg, manifest: { ...pkg.manifest, version: "0.1.1" } },
        first.gameId,
      );
      expect(again.response.statusCode, again.response.body).toBe(200);
      expect(again.response.json().buildHash).toBe(buildHash);

      const game = await api.call("GET", `/api/games/${first.gameId}`, { token });
      const versions = game.json().versions.map((v: unknown) => VersionResponseSchema.parse(v));
      expect(
        versions.map((v: { status: string; buildHash: string }) => [v.status, v.buildHash]),
      ).toEqual([
        ["ready", buildHash],
        ["ready", buildHash],
      ]);
    });
  }, 30_000);

  it("rejects a corrupt content hash at upload", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const pkg = sandboxPackage();
      const versionId = await createDraft(
        api,
        token,
        await createGame(api, token, "sandbox-test"),
        pkg.manifest,
      );
      const response = await upload(api, token, versionId, "assets/back.png", PNG, sha256("other"));
      expect(response.statusCode).toBe(400);
      expect(errorsOf(response)).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [{ path: "assets/back.png", message: "Content does not match x-content-sha256" }],
      });
    });
  });

  it("rejects a missing asset at finalize and keeps the version failed with its errors", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const { "assets/fish.png": _missing, ...files } = sandboxPackage().files;
      const result = await publish(api, token, { ...sandboxPackage(), files });
      expect(result.response.statusCode).toBe(400);
      const error = errorsOf(result.response);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.errors).toEqual([
        { path: "defs.1.front", message: "Missing asset assets/fish.png" },
      ]);
      const game = await api.call("GET", `/api/games/${result.gameId}`, { token });
      expect(game.json().versions[0]).toMatchObject({
        status: "failed",
        buildHash: null,
        validationErrors: error.errors,
      });

      // Uploading the fix returns the version to draft; finalize then succeeds.
      await uploadAll(api, token, result.versionId, { "assets/fish.png": PNG });
      expect((await finalize(api, token, result.versionId)).statusCode).toBe(200);
    });
  });

  it("rejects .wasm files by path and by content", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const pkg = sandboxPackage();
      const versionId = await createDraft(
        api,
        token,
        await createGame(api, token, "sandbox-test"),
        pkg.manifest,
      );
      const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const byPath = await upload(api, token, versionId, "lib/game.wasm", wasm);
      expect(byPath.statusCode).toBe(400);
      expect(errorsOf(byPath)).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [{ path: "lib/game.wasm", message: "Game WASM is not allowed in Phase 1" }],
      });
      const disguised = await upload(api, token, versionId, "lib/data.bin", wasm);
      expect(errorsOf(disguised).errors).toEqual([
        { path: "lib/data.bin", message: "Game WASM is not allowed in Phase 1" },
      ]);
    });
  });

  it("rejects SVG images in components and as uploads", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const pkg = sandboxPackage();
      const components = JSON.parse(pkg.files["components.json"]?.toString("utf8") ?? "{}");
      components.defs[1].front = "assets/fish.svg";
      const result = await publish(api, token, {
        ...pkg,
        files: { ...pkg.files, "components.json": Buffer.from(JSON.stringify(components)) },
      });
      expect(result.response.statusCode).toBe(400);
      const error = errorsOf(result.response);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.errors).toContainEqual({
        path: "defs.1.front",
        message: "SVG and game WASM assets are not allowed in Phase 1",
      });
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const uploaded = await upload(api, token, result.versionId, "assets/fish.svg", svg);
      expect(errorsOf(uploaded).errors).toContainEqual({
        path: "assets/fish.svg",
        message: "SVG files are not allowed in Phase 1",
      });
    });
  });

  it("rejects a bundle with an import statement", async () => {
    await withRules(async (api) => {
      const token = await api.designer();
      const pkg = await harborMarket();
      const bundle = Buffer.from(`import { x } from "./other.js";\n${pkg.files["dist/game.js"]}`);
      const result = await publish(api, token, {
        ...pkg,
        files: { ...pkg.files, "dist/game.js": bundle },
      });
      expect(result.response.statusCode).toBe(400);
      expect(errorsOf(result.response)).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [{ path: "dist/game.js", message: "Bundles may not contain import statements" }],
      });
    });
  }, 30_000);

  it("rejects a bundle whose setup fails in the rules host, for each player count", async () => {
    await withRules(async (api) => {
      const token = await api.designer();
      const pkg = await harborMarket();
      const broken = Buffer.from(
        "export default { sdk: 1, setup() { throw new Error('no'); }, moves: {}, playerView() { return null; }, present() { return { items: [], zones: [] }; } };",
      );
      const result = await publish(api, token, {
        ...pkg,
        files: { ...pkg.files, "dist/game.js": broken },
      });
      expect(result.response.statusCode).toBe(400);
      expect(errorsOf(result.response).errors).toEqual([
        { path: "dist/game.js", message: "setup failed in the rules host for 2 players" },
        { path: "dist/game.js", message: "setup failed in the rules host for 4 players" },
      ]);
    });
  }, 30_000);
});

describe("version files", () => {
  it("rejects image content that does not match its extension", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const pkg = sandboxPackage();
      const versionId = await createDraft(
        api,
        token,
        await createGame(api, token, "sandbox-test"),
        pkg.manifest,
      );
      const response = await upload(
        api,
        token,
        versionId,
        "assets/back.png",
        Buffer.from("GIF89a"),
      );
      expect(errorsOf(response).errors).toEqual([
        { path: "assets/back.png", message: "File content is not a valid png image" },
      ]);
    });
  });

  it("stores JSON bodies raw, replaces files and serves them to the owner only", async () => {
    await withApi(harness, async (api) => {
      const owner = await api.designer();
      const other = await api.designer("designer-2");
      const pkg = sandboxPackage();
      const versionId = await createDraft(
        api,
        owner,
        await createGame(api, owner, "sandbox-test"),
        pkg.manifest,
      );
      const json = Buffer.from('{ "spacing": "kept" }');
      const sent = await api.call("PUT", `/api/versions/${versionId}/files/notes.json`, {
        token: owner,
        body: json,
        headers: { "x-content-sha256": sha256(json), "content-type": "application/json" },
      });
      expect(sent.statusCode).toBe(204);
      const download = await api.call("GET", `/api/versions/${versionId}/files/notes.json`, {
        token: owner,
      });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload.equals(json)).toBe(true);
      expect(download.headers).toMatchObject({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
        etag: `"${sha256(json)}"`,
      });
      const cached = await api.call("GET", `/api/versions/${versionId}/files/notes.json`, {
        token: owner,
        headers: { "if-none-match": `"${sha256(json)}"` },
      });
      expect(cached.statusCode).toBe(304);
      expect(
        (await api.call("GET", `/api/versions/${versionId}/files/notes.json`, { token: other }))
          .statusCode,
      ).toBe(403);
      expect(
        (await api.call("GET", `/api/versions/${versionId}/files/missing.json`, { token: owner }))
          .statusCode,
      ).toBe(404);
      expect((await upload(api, other, versionId, "notes.json", json)).statusCode).toBe(403);
      expect(
        (await api.call("GET", `/api/versions/${versionId}/files/notes.json`)).statusCode,
      ).toBe(401);
    });
  });

  it("makes ready versions immutable and serves them as immutable", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const result = await publish(api, token, sandboxPackage());
      expect(result.response.statusCode).toBe(200);
      const again = await finalize(api, token, result.versionId);
      expect(again.json()).toEqual(result.response.json());
      const changed = await upload(api, token, result.versionId, "assets/back.png", PNG);
      expect(changed.statusCode).toBe(409);
      expect(errorsOf(changed).code).toBe("CONFLICT");
      const download = await api.call(
        "GET",
        `/api/versions/${result.versionId}/files/assets/back.png`,
        { token },
      );
      expect(download.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(download.headers["content-type"]).toBe("image/png");
    });
  });

  it("checks the manifest when a draft is created", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const gameId = await createGame(api, token, "sandbox-test");
      const pkg = sandboxPackage();
      const wrongSlug = await api.call("POST", `/api/games/${gameId}/versions`, {
        token,
        body: { ...pkg.manifest, id: "other-game" },
      });
      expect(errorsOf(wrongSlug)).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [{ path: "id", message: "Manifest id must equal the game slug sandbox-test" }],
      });
      const invalid = await api.call("POST", `/api/games/${gameId}/versions`, {
        token,
        body: { ...pkg.manifest, players: { min: 3, max: 2 } },
      });
      expect(errorsOf(invalid).code).toBe("VALIDATION_FAILED");
      await createDraft(api, token, gameId, pkg.manifest);
      const duplicate = await api.call("POST", `/api/games/${gameId}/versions`, {
        token,
        body: pkg.manifest,
      });
      expect(duplicate.statusCode).toBe(409);
      const other = await api.designer("designer-2");
      const foreign = await api.call("POST", `/api/games/${gameId}/versions`, {
        token: other,
        body: { ...pkg.manifest, version: "0.2.0" },
      });
      expect(foreign.statusCode).toBe(403);
      expect(
        (
          await finalize(
            api,
            other,
            await createDraft(api, token, gameId, { ...pkg.manifest, version: "0.3.0" }),
          )
        ).statusCode,
      ).toBe(403);
    });
  });

  it("rejects sandbox zones owned by seats that do not exist at the minimum count", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const pkg = sandboxPackage();
      const components = JSON.parse(pkg.files["components.json"]?.toString("utf8") ?? "{}");
      components.zones[1].owner = "2";
      const result = await publish(api, token, {
        manifest: { ...pkg.manifest, players: { min: 2, max: 4 } },
        files: { ...pkg.files, "components.json": Buffer.from(JSON.stringify(components)) },
      });
      expect(errorsOf(result.response).errors).toEqual([
        { path: "zones.1.owner", message: "Seat 2 does not exist with 2 players" },
      ]);
    });
  });
});
