import {
  ComponentsFileSchema,
  checkPackageComponents,
  defaultOptions,
  findModuleImports,
  type HostBuild,
  type Json,
  MAX_HOST_SOURCE_BYTES,
  type Manifest,
  optionsForManifestSchema,
  type ValidationError,
} from "@bgp/schema";
import { issuesToErrors } from "../http/errors.js";
import {
  buildHash,
  MAX_BUNDLE_BYTES,
  MAX_VERSION_BYTES,
  MAX_VERSION_FILES,
  type VersionFile,
} from "./files.js";

/** Runs the game's `setup` in the rules host; returns the seat counts that failed. */
export interface SetupChecker {
  check(
    build: HostBuild & { buildHash: string },
    seatCounts: number[],
    options: Record<string, Json>,
  ): Promise<number[]>;
}

export interface FinalizeInput {
  manifest: Manifest;
  files: readonly VersionFile[];
  /** Reads an uploaded file's bytes; called only for files listed in `files`. */
  read(path: string): Promise<Uint8Array>;
  setup: SetupChecker;
}

export { defaultOptions };

export type FinalizeResult =
  | { ok: true; buildHash: string }
  | { ok: false; errors: ValidationError[] };

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Every finalize check from manifest.md; failures are reported together. */
export async function validateVersion(input: FinalizeInput): Promise<FinalizeResult> {
  const { manifest, files } = input;
  const errors: ValidationError[] = [];
  const paths = new Set(files.map((file) => file.path));
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (files.length > MAX_VERSION_FILES) {
    errors.push({ path: "", message: `A version may contain at most ${MAX_VERSION_FILES} files` });
  }
  if (total > MAX_VERSION_BYTES) {
    errors.push({ path: "", message: "A version may contain at most 100 MB" });
  }
  for (const path of paths) {
    if (/\.(wasm|svg)$/i.test(path)) {
      errors.push({ path, message: "SVG and game WASM files are not allowed in Phase 1" });
    }
  }

  // A sandbox game runs from its components file in the rules host (T17), so the file is
  // kept as text for the setup check below.
  let componentsText: string | undefined;
  const componentsFile = files.find((file) => file.path === manifest.components);
  if (!componentsFile) {
    errors.push({ path: manifest.components, message: "Missing components file" });
  } else if (manifest.mode === "sandbox" && componentsFile.bytes > MAX_HOST_SOURCE_BYTES) {
    errors.push({
      path: manifest.components,
      message: "The components file of a sandbox game may be at most 2 MB",
    });
  } else {
    let raw: unknown;
    try {
      componentsText = decodeUtf8(await input.read(manifest.components));
      raw = JSON.parse(componentsText);
    } catch {
      errors.push({
        path: manifest.components,
        message: "Components file is not valid UTF-8 JSON",
      });
    }
    if (raw !== undefined) {
      const parsed = ComponentsFileSchema.safeParse(raw);
      if (parsed.success) errors.push(...checkPackageComponents(manifest, parsed.data, paths));
      else errors.push(...issuesToErrors(parsed.error.issues));
    }
  }

  let source: string | undefined;
  if (manifest.mode === "enforced") {
    const entry = files.find((file) => file.path === manifest.entry);
    if (!entry) {
      errors.push({ path: manifest.entry, message: "Missing game bundle" });
    } else if (entry.bytes > MAX_BUNDLE_BYTES) {
      errors.push({ path: manifest.entry, message: "The game bundle may be at most 2 MB" });
    } else {
      try {
        source = decodeUtf8(await input.read(entry.path));
      } catch {
        errors.push({ path: manifest.entry, message: "The game bundle is not valid UTF-8" });
      }
      for (const message of source === undefined ? [] : findModuleImports(source)) {
        errors.push({ path: manifest.entry, message });
      }
    }
  }

  const options = defaultOptions(manifest);
  if (!optionsForManifestSchema(manifest).safeParse(options).success) {
    errors.push({ path: "options", message: "Option defaults do not satisfy their declarations" });
  }
  if (errors.length > 0) return { ok: false, errors };

  const hash = buildHash(files);
  const digests = Object.fromEntries(files.map((file) => [file.path, file.sha256]));
  const build: (HostBuild & { buildHash: string }) | undefined =
    manifest.mode === "enforced"
      ? source === undefined
        ? undefined
        : { buildHash: hash, entry: manifest.entry, files: digests, source }
      : componentsText === undefined
        ? undefined
        : {
            buildHash: hash,
            mode: "sandbox",
            components: manifest.components,
            files: digests,
            source: componentsText,
          };
  if (build) {
    const counts = [...new Set([manifest.players.min, manifest.players.max])];
    const failed = await input.setup.check(build, counts, options);
    const path = manifest.mode === "enforced" ? manifest.entry : manifest.components;
    for (const count of failed) {
      errors.push({
        path,
        message: `setup failed in the rules host for ${count} player${count === 1 ? "" : "s"}`,
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, buildHash: hash };
}
