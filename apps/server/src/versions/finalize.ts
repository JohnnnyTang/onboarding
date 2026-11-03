import {
  type ComponentDef,
  type ComponentsFile,
  ComponentsFileSchema,
  GamePackageSchema,
  type HostBuild,
  type Json,
  type Manifest,
  optionsForManifestSchema,
  type ValidationError,
} from "@bgp/schema";
import { issuesToErrors } from "../http/errors.js";
import { findModuleImports } from "./bundle-scan.js";
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

export type FinalizeResult =
  | { ok: true; buildHash: string }
  | { ok: false; errors: ValidationError[] };

export function defaultOptions(manifest: Manifest): Record<string, Json> {
  return Object.fromEntries((manifest.options ?? []).map((option) => [option.id, option.default]));
}

function assetFields(def: ComponentDef): [string, string][] {
  switch (def.kind) {
    case "card":
      return [["front", def.front]];
    case "cardBack":
    case "board":
      return [["image", def.image]];
    case "token":
      return def.back
        ? [
            ["front", def.front],
            ["back", def.back],
          ]
        : [["front", def.front]];
    case "piece":
      return def.model
        ? [
            ["image", def.image],
            ["model", def.model],
          ]
        : [["image", def.image]];
    case "die":
      return (def.faces ?? []).flatMap((face, index): [string, string][] =>
        /\.(png|jpe?g|webp|avif)$/i.test(face) ? [[`faces.${index}`, face]] : [],
      );
  }
}

function checkComponents(
  manifest: Manifest,
  components: ComponentsFile,
  paths: ReadonlySet<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const pkg = GamePackageSchema.safeParse({ manifest, components });
  if (!pkg.success) {
    for (const issue of pkg.error.issues) {
      errors.push({ path: manifest.components, message: issue.message });
    }
  }
  for (const [index, def] of components.defs.entries()) {
    for (const [field, ref] of assetFields(def)) {
      if (!paths.has(ref)) {
        errors.push({ path: `defs.${index}.${field}`, message: `Missing asset ${ref}` });
      }
    }
  }
  if (manifest.mode === "sandbox") {
    // The sandbox definition rejects zones owned by seats that do not exist at setup.
    for (const [index, zone] of (components.zones ?? []).entries()) {
      if (
        zone.owner !== undefined &&
        zone.owner !== "each" &&
        Number(zone.owner) >= manifest.players.min
      ) {
        errors.push({
          path: `zones.${index}.owner`,
          message: `Seat ${zone.owner} does not exist with ${manifest.players.min} players`,
        });
      }
    }
  }
  return errors;
}

async function readJson(bytes: Uint8Array): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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

  if (!paths.has(manifest.components)) {
    errors.push({ path: manifest.components, message: "Missing components file" });
  } else {
    let raw: unknown;
    try {
      raw = await readJson(await input.read(manifest.components));
    } catch {
      errors.push({
        path: manifest.components,
        message: "Components file is not valid UTF-8 JSON",
      });
    }
    if (raw !== undefined) {
      const parsed = ComponentsFileSchema.safeParse(raw);
      if (parsed.success) errors.push(...checkComponents(manifest, parsed.data, paths));
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
        source = new TextDecoder("utf-8", { fatal: true }).decode(await input.read(entry.path));
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
  if (manifest.mode === "enforced" && source !== undefined) {
    const digests = Object.fromEntries(files.map((file) => [file.path, file.sha256]));
    const counts = [...new Set([manifest.players.min, manifest.players.max])];
    const failed = await input.setup.check(
      { buildHash: hash, entry: manifest.entry, files: digests, source },
      counts,
      options,
    );
    for (const count of failed) {
      errors.push({
        path: manifest.entry,
        message: `setup failed in the rules host for ${count} player${count === 1 ? "" : "s"}`,
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, buildHash: hash };
}
