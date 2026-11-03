import type { Manifest } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { findModuleImports } from "../src/versions/bundle-scan.js";
import { buildHash, checkUploadedFile, contentTypeFor } from "../src/versions/files.js";
import { PNG, sha256 } from "./api-fixture.js";

describe("findModuleImports", () => {
  it.each([
    ['import { a } from "./a.js";', "Bundles may not contain import statements"],
    ['import "./side-effect.js";', "Bundles may not contain import statements"],
    ["import * as all from 'x';", "Bundles may not contain import statements"],
    ["import def from 'x';", "Bundles may not contain import statements"],
    ["const m = import('node:fs');", "Bundles may not use dynamic import()"],
    ["const u = import.meta.url;", "Bundles may not use import.meta"],
    ["export * from './a.js';", "Bundles may not re-export other modules"],
    ["export { a as b } from './a.js';", "Bundles may not re-export other modules"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source under test
    ["const x = `${1}`; import('a');", "Bundles may not use dynamic import()"],
  ])("finds %s", (source, message) => {
    expect(findModuleImports(source)).toEqual([message]);
  });

  it.each([
    "export default { sdk: 1 };",
    "const a = 1; export { a as default };",
    "// import x from 'y';\nexport default {};",
    "/* import('x') */ export default {};",
    'const s = "import x from y"; export default s;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source under test
    "const t = `import ${'{'} a } from 'b'`; export default t;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source under test
    "const t = `outer ${`inner import('x')`} end`; export default t;",
    "const r = /import\\s+x/g; export default r;",
    "const r = x / 2 / 3; const o = { import: 1 }; o.import; export default r;",
    "if (a) /import('x')/.test(s); export default 1;",
  ])("accepts %s", (source) => {
    expect(findModuleImports(source)).toEqual([]);
  });
});

const manifest: Manifest = {
  schemaVersion: 1,
  id: "a-game",
  name: "A game",
  version: "1.0.0",
  mode: "enforced",
  sdk: 1,
  players: { min: 1, max: 2 },
  entry: "dist/game.js",
  components: "components.json",
};

describe("version files", () => {
  it("computes the manifest.md build hash independently of input order", () => {
    const files = [
      { path: "b.png", sha256: "b".repeat(64), bytes: 1 },
      { path: "a.json", sha256: "a".repeat(64), bytes: 1 },
    ];
    const expected = sha256(`a.json\t${"a".repeat(64)}\nb.png\t${"b".repeat(64)}\n`);
    expect(buildHash(files)).toBe(expected);
    expect(buildHash([...files].reverse())).toBe(expected);
  });

  it("checks image signatures, sizes, SVG, WASM and the bundle limit", () => {
    expect(checkUploadedFile("a.png", PNG, manifest)).toEqual([]);
    expect(checkUploadedFile("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), manifest)).toEqual([]);
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
    expect(checkUploadedFile("a.webp", webp, manifest)).toEqual([]);
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypmif1\0\0\0\0mif1avif", "latin1"),
    ]);
    expect(checkUploadedFile("a.avif", avif, manifest)).toEqual([]);
    expect(checkUploadedFile("a.avif", PNG, manifest)).toEqual([
      { path: "a.avif", message: "File content is not a valid avif image" },
    ]);
    expect(
      checkUploadedFile("big.png", Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), manifest),
    ).toEqual([{ path: "big.png", message: "Images may be at most 5 MB" }]);
    expect(checkUploadedFile("a.svg", Buffer.from("<svg/>"), manifest)).toEqual([
      { path: "a.svg", message: "SVG files are not allowed in Phase 1" },
    ]);
    expect(checkUploadedFile("dist/game.js", Buffer.alloc(2 * 1024 * 1024 + 1), manifest)).toEqual([
      { path: "dist/game.js", message: "The game bundle may be at most 2 MB" },
    ]);
    expect(checkUploadedFile("other.js", Buffer.alloc(2 * 1024 * 1024 + 1), manifest)).toEqual([]);
  });

  it("derives served content types from paths", () => {
    expect(contentTypeFor("assets/A.PNG")).toBe("image/png");
    expect(contentTypeFor("dist/game.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("components.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("model.glb")).toBe("application/octet-stream");
    expect(contentTypeFor(".hidden")).toBe("application/octet-stream");
  });
});
