import type { ProjectImageType } from "@bgp/schema";
import type { ProjectAsset } from "./project-store";

/** Per-image limit for game versions (manifest.md). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/avif";

const EXTENSIONS: Record<ProjectImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * The image type from the file's first bytes. The browser's MIME type comes from the file
 * name, so it is not trusted; SVG and anything else are refused.
 */
export function sniffImageType(bytes: Uint8Array): ProjectImageType | null {
  if (bytes.length >= 8 && ascii(bytes, 1, 4) === "PNG" && bytes[0] === 0x89) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/** "Fish Card (1).PNG" → "assets/fish-card-1.png", made unique among `taken`. */
export function assetPathFor(fileName: string, type: ProjectImageType, taken: Iterable<string>) {
  const used = new Set(taken);
  const stem =
    fileName
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image";
  const extension = EXTENSIONS[type];
  let path = `assets/${stem}.${extension}`;
  for (let n = 2; used.has(path); n += 1) path = `assets/${stem}-${n}.${extension}`;
  return path;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ImageImportError extends Error {
  override readonly name = "ImageImportError";
}

/** Reads one chosen file into a project image, or explains why it cannot be used. */
export async function readImage(
  file: Blob & { name: string },
  projectId: string,
  taken: Iterable<string>,
): Promise<ProjectAsset> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageImportError(`${file.name} is larger than 5 MB.`);
  }
  const bytes = await file.arrayBuffer();
  const contentType = sniffImageType(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16)));
  if (!contentType) {
    throw new ImageImportError(`${file.name} is not a PNG, JPEG, WebP or AVIF image.`);
  }
  return {
    projectId,
    path: assetPathFor(file.name, contentType, taken),
    sha256: await sha256Hex(bytes),
    contentType,
    size: bytes.byteLength,
    blob: new Blob([bytes], { type: contentType }),
  };
}
