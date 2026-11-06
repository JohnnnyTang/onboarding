import { crc32, deflateSync } from "node:zlib";

// Placeholder art for the `bgp init` template: plain PNG cards with a large number, drawn
// here so the template carries no binary files. Designers replace them with their own.

/** Pixels per millimeter: 63 x 88 mm cards become 252 x 352 px. */
const SCALE = 4;
const WIDTH = 63 * SCALE;
const HEIGHT = 88 * SCALE;

type Rgb = readonly [number, number, number];

/** 5 x 7 bitmap digits, one string per row. */
const DIGITS: Record<string, readonly string[]> = {
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
};

const INK: readonly Rgb[] = [
  [178, 34, 52],
  [214, 98, 22],
  [176, 132, 0],
  [62, 128, 40],
  [18, 120, 110],
  [24, 92, 168],
  [74, 60, 160],
  [128, 44, 132],
  [60, 60, 60],
];

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes RGB pixels as an 8-bit truecolor PNG. */
function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

function border(x: number, y: number, inset: number, width: number): boolean {
  const d = Math.min(x - inset, y - inset, WIDTH - 1 - inset - x, HEIGHT - 1 - inset - y);
  return d >= 0 && d < width;
}

/** A card face showing `value` (1-9) in large type. */
export function cardFront(value: number): Buffer {
  const glyph = DIGITS[String(value)];
  const ink = INK[(value - 1) % INK.length];
  if (!glyph || !ink) throw new Error(`No art for value ${value}`);
  const cell = 24;
  const left = Math.floor((WIDTH - 5 * cell) / 2);
  const top = Math.floor((HEIGHT - 7 * cell) / 2);
  return encodePng(WIDTH, HEIGHT, (x, y) => {
    if (border(x, y, 0, 6)) return [40, 40, 40];
    if (border(x, y, 14, 4)) return ink;
    const col = Math.floor((x - left) / cell);
    const row = Math.floor((y - top) / cell);
    if (x >= left && y >= top && glyph[row]?.[col] === "#") return ink;
    return [246, 240, 226];
  });
}

/** The shared card back. */
export function cardBack(): Buffer {
  return encodePng(WIDTH, HEIGHT, (x, y) => {
    if (border(x, y, 0, 6)) return [20, 24, 40];
    if (border(x, y, 14, 4)) return [214, 182, 96];
    return (x + y) % 32 < 16 ? [36, 52, 104] : [44, 64, 124];
  });
}
