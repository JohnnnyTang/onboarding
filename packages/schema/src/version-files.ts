import type { Json } from "./common.js";
import type { ValidationError } from "./http.js";
import { GamePackageSchema, type Manifest } from "./manifest.js";
import type { ComponentDef, ComponentsFile } from "./table.js";

// Version checks from manifest.md that need no I/O. The server runs them on upload and
// finalize, and `bgp validate` runs them before publishing, so both report the same errors.

export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** No Phase 1 file type may exceed the image limit. */
export const MAX_FILE_BYTES = MAX_IMAGE_BYTES;
export const MAX_VERSION_BYTES = 100 * 1024 * 1024;
export const MAX_VERSION_FILES = 2000;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
};

/** Lowercase extension of the last path segment, without the dot; "" when there is none. */
export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The image media type for a path, from its extension; undefined for other files. */
export function imageTypeFor(path: string): string | undefined {
  return IMAGE_TYPES[fileExtension(path)];
}

export function isImagePath(path: string): boolean {
  return imageTypeFor(path) !== undefined;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const size = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset).getUint32(0));
  // Major brand at 8; compatible brands from 16, four bytes each.
  for (let offset = 8; offset + 4 <= size; offset += offset === 8 ? 8 : 4) {
    const brand = ascii(bytes, offset, offset + 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

function matchesImageSignature(path: string, bytes: Uint8Array): boolean {
  switch (imageTypeFor(path)) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "image/avif":
      return isAvif(bytes);
    default:
      return false;
  }
}

/** Content checks that need only one file; finalize repeats nothing it can trust from here. */
export function checkUploadedFile(
  path: string,
  bytes: Uint8Array,
  manifest: Manifest,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (message: string) => errors.push({ path, message });
  const ext = fileExtension(path);
  if (ext === "svg") add("SVG files are not allowed in Phase 1");
  if (ext === "wasm" || startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) {
    add("Game WASM is not allowed in Phase 1");
  }
  if (isImagePath(path)) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) add("Images may be at most 5 MB");
    if (!matchesImageSignature(path, bytes)) add(`File content is not a valid ${ext} image`);
  }
  if (manifest.mode === "enforced" && path === manifest.entry) {
    if (bytes.byteLength > MAX_BUNDLE_BYTES) add("The game bundle may be at most 2 MB");
  }
  return errors;
}

/** The declared option defaults, which finalize's setup check and new matches start from. */
export function defaultOptions(manifest: Manifest): Record<string, Json> {
  return Object.fromEntries((manifest.options ?? []).map((option) => [option.id, option.default]));
}

/** Asset fields of a definition, as `[field, ref]`, so errors can name `defs.<i>.<field>`. */
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

/**
 * Finalize's checks of a parsed components file against its manifest and the version's file
 * paths: the package schema, every asset reference, and sandbox zones owned by seats that do
 * not exist at `players.min`.
 */
export function checkPackageComponents(
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
