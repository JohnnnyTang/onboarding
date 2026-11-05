import { CARD_FONT_SUBSETS, CARD_FONT_WEIGHTS, CARD_FONTS } from "@bgp/card-generator";
import { describe, expect, it } from "vitest";
import { CARD_FONT_FACES } from "./fonts";

describe("bundled card fonts", () => {
  it("bundles every font in every subset and weight, each with its unicode range", () => {
    const expected = CARD_FONTS.flatMap((font) =>
      CARD_FONT_SUBSETS.flatMap((subset) =>
        CARD_FONT_WEIGHTS.map((weight) => `${font.id} ${subset} ${weight}`),
      ),
    );
    const faces = CARD_FONT_FACES.map((face) => {
      const subset = face.unicodeRange.startsWith("U+0000") ? "latin" : "latin-ext";
      return `${face.font} ${subset} ${face.weight}`;
    });
    expect(faces.sort()).toEqual(expected.sort());
    for (const face of CARD_FONT_FACES) {
      expect(face.unicodeRange).toMatch(/^U\+[0-9A-F]{4}/);
      expect(typeof face.source).toBe("string");
    }
  });
});
