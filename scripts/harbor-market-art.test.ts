import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { GAME, harborArt } from "./harbor-art.js";

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(bytes: Buffer): [number, number] | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("Harbor Market's templates and CSV make exactly the images its components use", async () => {
  const art = await harborArt();
  expect(art.faces.size).toBe(16);
  expect(art.goods.size_mm).toEqual([63, 88]);
});

test("every Harbor Market image is committed as a 300 dpi PNG (pnpm art:harbor)", async () => {
  const art = await harborArt();
  for (const path of art.faces.keys()) {
    const bytes = await readFile(new URL(path, GAME));
    expect(pngSize(bytes), path).toEqual([744, 1039]);
    expect(bytes.length, path).toBeLessThan(5 * 1024 * 1024);
  }
});
