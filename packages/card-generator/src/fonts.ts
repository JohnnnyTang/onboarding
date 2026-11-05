import type { CardFont } from "@bgp/schema";

// Fonts for card text (contracts/card-generator.md#fonts). Templates name one of six fonts
// bundled with the app, so a card looks the same on every system and offline. The callers
// supply the font files (the web app self-hosts them; the Harbor Market art script reads
// them from disk); this module names them and loads them into a FontFaceSet.

export type CardFontId =
  | "inter"
  | "atkinson-hyperlegible"
  | "source-serif-4"
  | "cinzel"
  | "oswald"
  | "jetbrains-mono";

export interface CardFontInfo {
  id: CardFontId;
  label: string;
  /** Family name the faces are registered under; unique, so no installed font is used. */
  family: string;
  /** Generic family used only while a face is missing. */
  fallback: "sans-serif" | "serif" | "monospace";
}

export const CARD_FONTS: readonly CardFontInfo[] = [
  { id: "inter", label: "Inter", family: "BGP Inter", fallback: "sans-serif" },
  {
    id: "atkinson-hyperlegible",
    label: "Atkinson Hyperlegible",
    family: "BGP Atkinson Hyperlegible",
    fallback: "sans-serif",
  },
  {
    id: "source-serif-4",
    label: "Source Serif 4",
    family: "BGP Source Serif 4",
    fallback: "serif",
  },
  { id: "cinzel", label: "Cinzel", family: "BGP Cinzel", fallback: "serif" },
  { id: "oswald", label: "Oswald", family: "BGP Oswald", fallback: "sans-serif" },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    family: "BGP JetBrains Mono",
    fallback: "monospace",
  },
];

const ALIASES: Record<"sans-serif" | "serif" | "monospace", CardFontId> = {
  "sans-serif": "inter",
  serif: "source-serif-4",
  monospace: "jetbrains-mono",
};

/** The bundled font a template's font value means (generic names are aliases). */
export function cardFont(font: CardFont): CardFontInfo {
  const id =
    font === "sans-serif" || font === "serif" || font === "monospace" ? ALIASES[font] : font;
  const info = CARD_FONTS.find((entry) => entry.id === id);
  if (!info) throw new Error(`Unknown card font ${font}`);
  return info;
}

/** Weights bundled per font: regular, and bold for `bold` text. */
export const CARD_FONT_WEIGHTS = [400, 700] as const;
/** Unicode subsets bundled per font. */
export const CARD_FONT_SUBSETS = ["latin", "latin-ext"] as const;

export type CardFontWeight = (typeof CARD_FONT_WEIGHTS)[number];
export type CardFontSubset = (typeof CARD_FONT_SUBSETS)[number];

/** The Fontsource file of one face: `@fontsource/<id>/files/<this name>`. */
export function cardFontFileName(
  id: CardFontId,
  subset: CardFontSubset,
  weight: CardFontWeight,
): string {
  return `${id}-${subset}-${weight}-normal.woff2`;
}

/** One font file to load: its URL, or its bytes. */
export interface CardFontFace {
  font: CardFontId;
  weight: CardFontWeight;
  unicodeRange: string;
  source: string | ArrayBuffer;
}

/**
 * Registers the faces in `fonts` (usually `document.fonts`) and waits until every one is
 * loaded, so canvas text measures and draws with them. Rejects when a face fails to load.
 */
export async function loadCardFonts(
  faces: readonly CardFontFace[],
  fonts: FontFaceSet,
): Promise<void> {
  await Promise.all(
    faces.map(async (face) => {
      const info = cardFont(face.font);
      const source =
        typeof face.source === "string" ? `url(${JSON.stringify(face.source)})` : face.source;
      const fontFace = new FontFace(info.family, source, {
        weight: String(face.weight),
        style: "normal",
        unicodeRange: face.unicodeRange,
      });
      fonts.add(fontFace);
      await fontFace.load();
    }),
  );
}
