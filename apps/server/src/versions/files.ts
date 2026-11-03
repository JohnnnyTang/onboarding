import { createHash } from "node:crypto";
import type { Manifest, ValidationError } from "@bgp/schema";

export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** No Phase 1 file type may exceed the image limit. */
export const MAX_FILE_BYTES = MAX_IMAGE_BYTES;
export const MAX_VERSION_BYTES = 100 * 1024 * 1024;
export const MAX_VERSION_FILES = 2000;

export interface VersionFile {
  path: string;
  sha256: string;
  bytes: number;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** manifest.md: SHA-256 over sorted `"<path>\t<sha256>\n"` lines. */
export function buildHash(files: readonly VersionFile[]): string {
  const paths = files.map((file) => file.path).sort();
  const digests = new Map(files.map((file) => [file.path, file.sha256]));
  return sha256Hex(paths.map((path) => `${path}\t${digests.get(path)}\n`).join(""));
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
};

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isImagePath(path: string): boolean {
  return extension(path) in IMAGE_TYPES;
}

/** Served content types come from the path, never from the uploader's headers. */
export function contentTypeFor(path: string): string {
  const ext = extension(path);
  const image = IMAGE_TYPES[ext];
  if (image) return image;
  if (ext === "js" || ext === "mjs") return "text/javascript; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "txt" || ext === "md" || ext === "csv") return "text/plain; charset=utf-8";
  return "application/octet-stream";
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
  switch (IMAGE_TYPES[extension(path)]) {
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
  const ext = extension(path);
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
