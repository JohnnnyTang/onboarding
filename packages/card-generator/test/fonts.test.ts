import { CARD_FONT_IDS, CardFontSchema } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import {
  CARD_FONTS,
  type CardFontFace,
  cardFont,
  cardFontFileName,
  fontFor,
  loadCardFonts,
} from "../src/index.js";
import { template } from "./fixtures.js";

describe("bundled card fonts", () => {
  test("the generator knows exactly the fonts the schema allows", () => {
    expect(CARD_FONTS.map((font) => font.id)).toEqual([...CARD_FONT_IDS]);
    for (const font of CardFontSchema.options) expect(cardFont(font)).toBeDefined();
  });

  test("generic names are aliases of bundled fonts", () => {
    expect(cardFont("sans-serif").id).toBe("inter");
    expect(cardFont("serif").id).toBe("source-serif-4");
    expect(cardFont("monospace").id).toBe("jetbrains-mono");
  });

  test("text uses the bundled family first and a generic family only as a fallback", () => {
    const title = template.fields[1];
    if (title?.kind !== "text") throw new Error("fixture");
    expect(fontFor({ ...title, font: "cinzel", bold: false }, 12)).toBe(
      '12.00px "BGP Cinzel", serif',
    );
  });

  test("file names follow Fontsource's layout", () => {
    expect(cardFontFileName("oswald", "latin-ext", 700)).toBe("oswald-latin-ext-700-normal.woff2");
  });

  test("loading registers every face under its family and waits for it", async () => {
    const loaded: string[] = [];
    class FakeFontFace {
      constructor(
        readonly family: string,
        readonly source: string | ArrayBuffer,
        readonly descriptors: FontFaceDescriptors,
      ) {}
      async load() {
        loaded.push(`${this.family} ${this.descriptors.weight}`);
        return this;
      }
    }
    const added: FakeFontFace[] = [];
    const previous = globalThis.FontFace;
    globalThis.FontFace = FakeFontFace as unknown as typeof FontFace;
    try {
      const faces: CardFontFace[] = [
        { font: "inter", weight: 400, unicodeRange: "U+0000-00FF", source: "/inter.woff2" },
        { font: "cinzel", weight: 700, unicodeRange: "U+0100-02BA", source: new ArrayBuffer(4) },
      ];
      await loadCardFonts(faces, {
        add: (face: FakeFontFace) => added.push(face),
      } as unknown as FontFaceSet);
    } finally {
      globalThis.FontFace = previous;
    }
    expect(loaded).toEqual(["BGP Inter 400", "BGP Cinzel 700"]);
    expect(added[0]?.source).toBe('url("/inter.woff2")');
    expect(added[1]?.descriptors.unicodeRange).toBe("U+0100-02BA");
  });
});
