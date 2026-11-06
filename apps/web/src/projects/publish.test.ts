import type { GameResponse, Manifest, VersionResponse } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/client";
import { fakeApi } from "../test/fake-api";
import { addComponent, createProject } from "./project-model";
import type { ProjectAsset } from "./project-store";
import {
  type PackageFile,
  packageFiles,
  publishProject,
  sha256Hex,
  stableJson,
  suggestVersion,
} from "./publish";

const NOW = "2026-11-06T00:00:00.000Z";

function asset(path: string, bytes: string): ProjectAsset {
  return {
    projectId: "p1",
    path,
    blob: new Blob([bytes], { type: "image/png" }),
    sha256: "0".repeat(64),
    contentType: "image/png",
    size: bytes.length,
  };
}

/** A card with its front at assets/fish.png and its back at assets/back.png. */
function project() {
  const base = addComponent(createProject("Harbor Sketch", "p1", NOW), "card", "assets/fish.png");
  const defs = base.project.components.defs.map((def) =>
    def.kind === "cardBack" ? { ...def, image: "assets/back.png" } : def,
  );
  return { ...base.project, components: { ...base.project.components, defs } };
}

describe("package files", () => {
  test("hold the components file and only the images the components use", async () => {
    const assets = [
      asset("assets/fish.png", "fish"),
      asset("assets/unused.png", "unused"),
      asset("assets/back.png", "back"),
    ];
    const { files, missing } = await packageFiles(project(), assets);
    expect(files.map((file) => file.path)).toEqual([
      "components.json",
      "assets/back.png",
      "assets/fish.png",
    ]);
    expect(missing).toEqual([]);
    expect(files[2]?.sha256).toBe(await sha256Hex(new Blob(["fish"])));
    expect(await files[0]?.blob.text()).toBe(stableJson(project().components));
  });

  test("report images the components name but the project lacks", async () => {
    const { missing } = await packageFiles(project(), [asset("assets/fish.png", "fish")]);
    expect(missing).toEqual(["assets/back.png"]);
  });

  test("give the same bytes whatever order the keys were written in", () => {
    expect(stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("version suggestion", () => {
  test("keeps the project's version until it is taken, then bumps the highest patch", () => {
    expect(suggestVersion("0.1.0", [])).toBe("0.1.0");
    expect(suggestVersion("0.1.0", ["0.1.0"])).toBe("0.1.1");
    expect(suggestVersion("0.1.0", ["0.1.0", "0.3.2", "0.2.9"])).toBe("0.3.3");
  });
});

const GAME: GameResponse = {
  id: "g1",
  slug: "harbor-sketch",
  name: "Harbor Sketch",
  visibility: "unlisted",
};

function recordingApi(options: { existing?: GameResponse; finalizeError?: ApiError } = {}) {
  const calls: string[] = [];
  const api = fakeApi({
    listGames: async () => {
      calls.push("list");
      return { items: options.existing ? [options.existing] : [], cursor: null };
    },
    createGame: async (body) => {
      calls.push(`createGame ${body.slug} ${body.visibility}`);
      return { ...GAME, ...body, id: "g1" };
    },
    updateGame: async (id, body) => {
      calls.push(`updateGame ${id} ${body.visibility}`);
      return { ...GAME, visibility: body.visibility ?? GAME.visibility };
    },
    createVersion: async (gameId, manifest: Manifest) => {
      calls.push(`createVersion ${gameId} ${manifest.version}`);
      return {
        id: "v1",
        gameId,
        manifest,
        status: "draft",
        buildHash: null,
        validationErrors: null,
      } as VersionResponse;
    },
    uploadVersionFile: async (versionId, path, _blob, sha256) => {
      calls.push(`upload ${versionId} ${path} ${sha256.slice(0, 4)}`);
    },
    finalizeVersion: async () => {
      calls.push("finalize");
      if (options.finalizeError) throw options.finalizeError;
      return { buildHash: "f".repeat(64) };
    },
  });
  return { api, calls };
}

const FILES: PackageFile[] = [
  { path: "components.json", blob: new Blob(["{}"]), sha256: "aaaa".repeat(16) },
  { path: "assets/fish.png", blob: new Blob(["x"]), sha256: "bbbb".repeat(16) },
];

describe("publishing", () => {
  test("creates the game on first publish, then a draft, uploads and finalizes", async () => {
    const { api, calls } = recordingApi();
    const stages: string[] = [];
    const result = await publishProject(api, {
      project: project(),
      files: FILES,
      version: "0.1.0",
      visibility: "private",
      onProgress: (progress) => stages.push(progress.stage),
    });
    expect(result).toMatchObject({
      ok: true,
      gameId: "g1",
      versionId: "v1",
      buildHash: "f".repeat(64),
    });
    expect(calls).toEqual([
      "list",
      "createGame harbor-sketch private",
      "createVersion g1 0.1.0",
      "upload v1 components.json aaaa",
      "upload v1 assets/fish.png bbbb",
      "finalize",
    ]);
    expect(new Set(stages)).toEqual(new Set(["game", "draft", "upload", "finalize"]));
  });

  test("reuses the designer's game and updates its visibility when changed", async () => {
    const { api, calls } = recordingApi({ existing: GAME });
    await publishProject(api, {
      project: project(),
      files: FILES,
      version: "0.1.1",
      visibility: "unlisted",
    });
    expect(calls.slice(0, 2)).toEqual(["list", "createVersion g1 0.1.1"]);
    const again = recordingApi({ existing: GAME });
    await publishProject(again.api, {
      project: project(),
      files: FILES,
      version: "0.1.1",
      visibility: "private",
    });
    expect(again.calls[1]).toBe("updateGame g1 private");
  });

  test("returns the server's validation errors with the failed draft", async () => {
    const errors = [{ path: "defs.0.front", message: "Missing asset assets/fish.png" }];
    const { api } = recordingApi({
      finalizeError: new ApiError(400, "VALIDATION_FAILED", "Invalid package", errors),
    });
    const result = await publishProject(api, {
      project: project(),
      files: FILES,
      version: "0.1.0",
      visibility: "private",
    });
    expect(result).toEqual({
      ok: false,
      stage: "finalize",
      message: "Invalid package",
      errors,
      gameId: "g1",
      versionId: "v1",
    });
  });

  test("throws errors that are not API errors, such as a lost connection", async () => {
    const api = fakeApi({ listGames: () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(
      publishProject(api, {
        project: project(),
        files: FILES,
        version: "0.1.0",
        visibility: "private",
      }),
    ).rejects.toThrow("Failed to fetch");
  });
});
