import { createHash } from "node:crypto";
import { fileExtension, imageTypeFor } from "@bgp/schema";

// The pure upload checks and limits live in @bgp/schema so `bgp validate` reports the same
// errors before a designer publishes.
export {
  checkUploadedFile,
  isImagePath,
  MAX_BUNDLE_BYTES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VERSION_BYTES,
  MAX_VERSION_FILES,
} from "@bgp/schema";

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

/** Served content types come from the path, never from the uploader's headers. */
export function contentTypeFor(path: string): string {
  const image = imageTypeFor(path);
  if (image) return image;
  const ext = fileExtension(path);
  if (ext === "js" || ext === "mjs") return "text/javascript; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "txt" || ext === "md" || ext === "csv") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
