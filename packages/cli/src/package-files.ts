import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkPackageComponents,
  checkUploadedFile,
  componentAssetRefs,
  defaultOptions,
  MAX_VERSION_BYTES,
  MAX_VERSION_FILES,
  optionsForManifestSchema,
  type ValidationError,
  VersionPathSchema,
} from "@bgp/schema";
import type { GamePackage } from "./game-package.js";

/** One file of the version, as the upload flow sends it. */
export interface VersionFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** manifest.md: SHA-256 over the sorted `"<path>\t<sha256>\n"` lines of the version. */
export function buildHashOf(files: readonly VersionFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\t${file.sha256}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/**
 * The files a version is made of: the components file, the bundle (enforced games) and every
 * asset the components reference. Sources, tests and unused files stay on this machine, as
 * unused images do when a project is published from the web app. Paths that cannot be read
 * are left out; `checkVersionFiles` reports them as missing assets.
 */
export async function collectVersionFiles(
  pkg: GamePackage,
  bundle: string | null,
): Promise<VersionFile[]> {
  const files = new Map<string, Uint8Array>();
  files.set(pkg.manifest.components, await readFile(join(pkg.dir, pkg.manifest.components)));
  if (pkg.manifest.mode === "enforced" && bundle !== null) {
    files.set(pkg.manifest.entry, new TextEncoder().encode(bundle));
  }
  for (const ref of new Set(componentAssetRefs(pkg.components))) {
    if (files.has(ref) || !VersionPathSchema.safeParse(ref).success) continue;
    try {
      files.set(ref, await readFile(join(pkg.dir, ref)));
    } catch {
      // Reported as a missing asset.
    }
  }
  return [...files]
    .map(([path, bytes]) => ({ path, bytes, sha256: sha256Hex(bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The upload and finalize checks that need no rules host, over the collected files. */
export function checkVersionFiles(
  pkg: GamePackage,
  files: readonly VersionFile[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (files.length > MAX_VERSION_FILES) {
    errors.push({ path: "", message: `A version may contain at most ${MAX_VERSION_FILES} files` });
  }
  if (total > MAX_VERSION_BYTES) {
    errors.push({ path: "", message: "A version may contain at most 100 MB" });
  }
  for (const file of files) {
    if (!VersionPathSchema.safeParse(file.path).success) {
      errors.push({ path: file.path, message: "Paths use only A-Z a-z 0-9 . _ / - and no .." });
    }
    errors.push(...checkUploadedFile(file.path, file.bytes, pkg.manifest));
  }
  const paths = new Set(files.map((file) => file.path));
  errors.push(...checkPackageComponents(pkg.manifest, pkg.components, paths));
  if (!optionsForManifestSchema(pkg.manifest).safeParse(defaultOptions(pkg.manifest)).success) {
    errors.push({ path: "options", message: "Option defaults do not satisfy their declarations" });
  }
  return errors;
}
