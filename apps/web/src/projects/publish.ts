import {
  componentAssetRefs,
  type GameResponse,
  type LocalProject,
  type Manifest,
  type ValidationError,
  type Visibility,
} from "@bgp/schema";
import { type ApiClient, ApiError } from "../api/client";
import type { ProjectAsset } from "./project-store";

// Publishing a local project (T17): build the package files, then the upload flow of
// contracts/manifest.md — find or create the game, create a draft, upload, finalize.

/** One file of the version, with the digest the server checks. */
export interface PackageFile {
  path: string;
  blob: Blob;
  sha256: string;
}

const IMAGE_REF = /\.(png|jpe?g|webp|avif)$/i;

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * JSON with object keys sorted, so the same project always gives the same bytes and so the
 * same build hash (AC-02), however its records were edited.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries);
  });
}

/**
 * The files of a version: `components.json` and every image the components use. Images that
 * are imported but unused stay on this device; card templates and CSV files are not
 * published. `missing` lists images the components name but the project does not have.
 */
export async function packageFiles(
  project: LocalProject,
  assets: readonly ProjectAsset[],
): Promise<{ files: PackageFile[]; missing: string[] }> {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const refs = [...new Set(componentAssetRefs(project.components))]
    .filter((ref) => IMAGE_REF.test(ref) || byPath.has(ref))
    .sort();
  const missing = refs.filter((ref) => !byPath.has(ref));
  const components = new Blob([stableJson(project.components)], { type: "application/json" });
  const entries: { path: string; blob: Blob }[] = [
    { path: project.manifest.components, blob: components },
    ...refs.flatMap((ref) => {
      const asset = byPath.get(ref);
      return asset ? [{ path: ref, blob: asset.blob }] : [];
    }),
  ];
  const files = await Promise.all(
    entries.map(async (entry) => ({ ...entry, sha256: await sha256Hex(entry.blob) })),
  );
  return { files, missing };
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The version to publish: the project's own version while the game does not have it yet,
 * otherwise the next patch after the highest published one.
 */
export function suggestVersion(projectVersion: string, published: readonly string[]): string {
  if (!published.includes(projectVersion)) return projectVersion;
  const parsed = published
    .map(parseSemver)
    .filter((version) => version !== null)
    .sort(compareSemver);
  const highest = parsed.at(-1) ?? [0, 1, 0];
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

/** The signed-in designer's game with this slug, if any. */
export async function findGame(api: ApiClient, slug: string): Promise<GameResponse | null> {
  let cursor: string | undefined;
  do {
    const page = await api.listGames({ limit: 200, ...(cursor ? { cursor } : {}) });
    const found = page.items.find((game) => game.slug === slug);
    if (found) return found;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return null;
}

export type PublishStage = "game" | "draft" | "upload" | "finalize";

export interface PublishProgress {
  stage: PublishStage;
  /** Files uploaded so far, during the upload stage. */
  done?: number;
  total?: number;
}

export interface PublishRequest {
  project: LocalProject;
  files: readonly PackageFile[];
  version: string;
  visibility: Visibility;
  onProgress?: (progress: PublishProgress) => void;
}

export type PublishResult =
  | { ok: true; gameId: string; versionId: string; buildHash: string; manifest: Manifest }
  | {
      ok: false;
      stage: PublishStage;
      message: string;
      errors: readonly ValidationError[];
      /** The draft that failed to finalize, if one was created. */
      versionId?: string;
      gameId?: string;
    };

function failed(
  stage: PublishStage,
  error: unknown,
  ids: { gameId?: string; versionId?: string } = {},
): PublishResult {
  if (error instanceof ApiError) {
    return { ok: false, stage, message: error.message, errors: error.errors, ...ids };
  }
  throw error;
}

/**
 * Publishes the project as a new version of the designer's game with the manifest's slug,
 * creating the game on first publish. Validation failures come back as a result with the
 * server's errors; other errors (network, sign-in) are thrown.
 */
export async function publishProject(
  api: ApiClient,
  request: PublishRequest,
): Promise<PublishResult> {
  const { project, files, onProgress } = request;
  const manifest: Manifest = { ...project.manifest, version: request.version };

  onProgress?.({ stage: "game" });
  let game: GameResponse;
  try {
    const existing = await findGame(api, manifest.id);
    if (!existing) {
      game = await api.createGame({
        slug: manifest.id,
        name: manifest.name,
        visibility: request.visibility,
      });
    } else if (existing.name !== manifest.name || existing.visibility !== request.visibility) {
      game = await api.updateGame(existing.id, {
        name: manifest.name,
        visibility: request.visibility,
      });
    } else {
      game = existing;
    }
  } catch (error) {
    return failed("game", error);
  }

  onProgress?.({ stage: "draft" });
  let versionId: string;
  try {
    versionId = (await api.createVersion(game.id, manifest)).id;
  } catch (error) {
    return failed("draft", error, { gameId: game.id });
  }

  const ids = { gameId: game.id, versionId };
  let done = 0;
  onProgress?.({ stage: "upload", done, total: files.length });
  try {
    // A few at a time: enough to overlap round trips without flooding the server.
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        await api.uploadVersionFile(versionId, file.path, file.blob, file.sha256);
        done += 1;
        onProgress?.({ stage: "upload", done, total: files.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  } catch (error) {
    return failed("upload", error, ids);
  }

  onProgress?.({ stage: "finalize" });
  try {
    const { buildHash } = await api.finalizeVersion(versionId);
    return { ok: true, gameId: game.id, versionId, buildHash, manifest };
  } catch (error) {
    return failed("finalize", error, ids);
  }
}
