import {
  type ComponentsFile,
  ComponentsFileSchema,
  componentAssetRefs,
  type Manifest,
} from "@bgp/schema";
import type { ApiClient } from "../api/client";

/** Same limit the server enforces on the bundle at finalize. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export class GamePackageError extends Error {
  override readonly name = "GamePackageError";
  constructor(readonly reason: "sandbox" | "invalid") {
    super(
      reason === "sandbox"
        ? "Sandbox games cannot be played at the table yet."
        : "This game version could not be read.",
    );
  }
}

/** Everything a seat needs to run and draw one game version. */
export interface GamePackage {
  manifest: Extract<Manifest, { mode: "enforced" }>;
  components: ComponentsFile;
  /** The `game.js` bundle source, for the game worker only. */
  source: string;
  /** A same-document URL for an image; empty when it could not be loaded (placeholder art). */
  assetUrl(ref: string): string;
  /** Releases the image object URLs. */
  dispose(): void;
}

export interface UrlFactory {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

async function readJson(blob: Blob): Promise<unknown> {
  try {
    return JSON.parse(await blob.text());
  } catch {
    throw new GamePackageError("invalid");
  }
}

/**
 * Loads a version for one match. Downloads need a bearer token, which an `<img>` cannot send,
 * so images are fetched here and handed to the renderer as object URLs. A missing image is
 * not fatal: the renderer draws a labeled placeholder.
 */
export async function loadGamePackage(
  api: ApiClient,
  versionId: string,
  matchId: string,
  urls: UrlFactory = URL,
): Promise<GamePackage> {
  const scope = { matchId };
  const version = await api.getVersion(versionId, scope);
  const manifest = version.manifest;
  if (manifest.mode !== "enforced") throw new GamePackageError("sandbox");
  const [componentsBlob, bundle] = await Promise.all([
    api.getVersionFile(versionId, manifest.components, scope),
    api.getVersionFile(versionId, manifest.entry, scope),
  ]);
  const parsed = ComponentsFileSchema.safeParse(await readJson(componentsBlob));
  if (!parsed.success || bundle.size > MAX_BUNDLE_BYTES) throw new GamePackageError("invalid");
  const components = parsed.data;
  const source = await bundle.text();

  const assets = new Map<string, string>();
  const refs = [...new Set(componentAssetRefs(components))].filter(
    (ref) => !/\.(glb|gltf)$/i.test(ref),
  );
  await Promise.all(
    refs.map(async (ref) => {
      try {
        const blob = await api.getVersionFile(versionId, ref, scope);
        assets.set(ref, urls.createObjectURL(blob));
      } catch {
        // Placeholder art for this image.
      }
    }),
  );
  let disposed = false;
  return {
    manifest,
    components,
    source,
    assetUrl: (ref) => (disposed ? "" : (assets.get(ref) ?? "")),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const url of assets.values()) urls.revokeObjectURL(url);
      assets.clear();
    },
  };
}
