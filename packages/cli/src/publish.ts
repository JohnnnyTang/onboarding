import {
  FinalizeResponseSchema,
  type GameDetailResponse,
  GameDetailResponseSchema,
  GameListResponseSchema,
  type GameResponse,
  GameResponseSchema,
  HttpErrorSchema,
  type ValidationError,
  type VersionResponse,
  VersionResponseSchema,
  type Visibility,
} from "@bgp/schema";
import { buildGame } from "./build.js";
import type { GamePackage } from "./game-package.js";
import { buildHashOf, checkVersionFiles, collectVersionFiles } from "./package-files.js";

// `bgp publish`: the upload flow of contracts/manifest.md. Find or create the game by the
// manifest's id, create a draft version, upload each file with its SHA-256, finalize.

export const DEFAULT_API_ORIGIN = "http://localhost:3000";

/** A failure the designer can act on, with the server's validation errors if any. */
export class PublishError extends Error {
  readonly errors: readonly ValidationError[];
  constructor(message: string, errors: readonly ValidationError[] = []) {
    super(message);
    this.name = "PublishError";
    this.errors = errors;
  }
}

export interface PublishOptions {
  apiOrigin: string;
  token: string;
  /** Visibility when the game is created; an existing game keeps its own. */
  visibility: Visibility;
  fetch?: typeof fetch;
  onProgress?(message: string): void;
}

export type PublishResult =
  | { status: "published"; game: GameResponse; version: VersionResponse; buildHash: string }
  /** The same version with the same files is already ready; nothing was uploaded. */
  | { status: "unchanged"; game: GameResponse; version: VersionResponse; buildHash: string };

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** A small client for the endpoints the upload flow uses, validating every response. */
function apiClient(options: PublishOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const origin = options.apiOrigin.replace(/\/$/, "");
  async function call<T>(
    method: string,
    path: string,
    parser: Parser<T> | null,
    init: { json?: unknown; body?: Uint8Array; sha256?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
    let body: string | Blob | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers["content-type"] = "application/octet-stream";
      body = new Blob([new Uint8Array(init.body)]);
    }
    if (init.sha256) headers["x-content-sha256"] = init.sha256;
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
      });
    } catch {
      throw new PublishError(`Cannot reach the platform API at ${origin}`);
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      // Reported below.
    }
    if (!response.ok) {
      const error = HttpErrorSchema.safeParse(data);
      if (!error.success)
        throw new PublishError(`${method} ${path} failed with HTTP ${response.status}`);
      throw new PublishError(error.data.error.message, error.data.error.errors ?? []);
    }
    if (parser === null) return undefined as T;
    const parsed = parser.safeParse(data);
    if (!parsed.success)
      throw new PublishError(`The API sent an unexpected response to ${method} ${path}`);
    return parsed.data;
  }
  return { call };
}

function filePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Builds the game, checks its files and runs the upload flow. */
export async function publishGame(
  pkg: GamePackage,
  options: PublishOptions,
): Promise<PublishResult> {
  const progress = options.onProgress ?? (() => {});
  const source = pkg.manifest.mode === "enforced" ? (await buildGame(pkg)).source : null;
  const files = await collectVersionFiles(pkg, source);
  const problems = checkVersionFiles(pkg, files);
  if (problems.length > 0) throw new PublishError("The package has errors", problems);
  const buildHash = buildHashOf(files);
  const { call } = apiClient(options);
  const { manifest } = pkg;

  let game: GameResponse | null = null;
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
    const page = await call("GET", `/api/games${query}`, GameListResponseSchema);
    game = page.items.find((item) => item.slug === manifest.id) ?? null;
    cursor = game ? null : page.cursor;
  } while (cursor);
  if (!game) {
    progress(`Creating the game ${manifest.id} (${options.visibility})`);
    game = await call("POST", "/api/games", GameResponseSchema, {
      json: { slug: manifest.id, name: manifest.name, visibility: options.visibility },
    });
  }
  const detail: GameDetailResponse = await call(
    "GET",
    `/api/games/${encodeURIComponent(game.id)}`,
    GameDetailResponseSchema,
  );
  let version = detail.versions.find(
    (candidate) => candidate.manifest.version === manifest.version,
  );
  if (version?.status === "ready") {
    if (version.buildHash === buildHash) return { status: "unchanged", game, version, buildHash };
    throw new PublishError(
      `Version ${manifest.version} of ${manifest.id} is already published with other files; raise "version" in bgp.json`,
    );
  }
  if (version) {
    progress(`Resuming the unfinished draft of ${manifest.version}`);
  } else {
    progress(`Creating version ${manifest.version}`);
    version = await call(
      "POST",
      `/api/games/${encodeURIComponent(game.id)}/versions`,
      VersionResponseSchema,
      { json: manifest },
    );
  }
  for (const [index, file] of files.entries()) {
    progress(`Uploading ${file.path} (${index + 1}/${files.length})`);
    await call(
      "PUT",
      `/api/versions/${encodeURIComponent(version.id)}/files/${filePath(file.path)}`,
      null,
      {
        body: file.bytes,
        sha256: file.sha256,
      },
    );
  }
  progress("Finalizing: the server validates the version and runs setup in the rules host");
  const finalized = await call(
    "POST",
    `/api/versions/${encodeURIComponent(version.id)}/finalize`,
    FinalizeResponseSchema,
    { json: {} },
  );
  if (finalized.buildHash !== buildHash) {
    throw new PublishError("The server's build hash differs from the files this CLI uploaded");
  }
  const ready = await call(
    "GET",
    `/api/versions/${encodeURIComponent(version.id)}`,
    VersionResponseSchema,
  );
  return { status: "published", game, version: ready, buildHash };
}
