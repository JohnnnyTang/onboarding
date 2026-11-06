import {
  type CardFontFace,
  type CardFontId,
  type CardFontSubset,
  type CardFontWeight,
  loadCardFonts,
} from "@bgp/card-generator";
import atkinsonHyperlegibleLatin400 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url";
import atkinsonHyperlegibleLatin700 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url";
import atkinsonHyperlegibleLatinExt400 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-ext-400-normal.woff2?url";
import atkinsonHyperlegibleLatinExt700 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-ext-700-normal.woff2?url";
import atkinsonHyperlegibleRanges from "@fontsource/atkinson-hyperlegible/unicode.json";
import cinzelLatin400 from "@fontsource/cinzel/files/cinzel-latin-400-normal.woff2?url";
import cinzelLatin700 from "@fontsource/cinzel/files/cinzel-latin-700-normal.woff2?url";
import cinzelLatinExt400 from "@fontsource/cinzel/files/cinzel-latin-ext-400-normal.woff2?url";
import cinzelLatinExt700 from "@fontsource/cinzel/files/cinzel-latin-ext-700-normal.woff2?url";
import cinzelRanges from "@fontsource/cinzel/unicode.json";
import interLatin400 from "@fontsource/inter/files/inter-latin-400-normal.woff2?url";
import interLatin700 from "@fontsource/inter/files/inter-latin-700-normal.woff2?url";
import interLatinExt400 from "@fontsource/inter/files/inter-latin-ext-400-normal.woff2?url";
import interLatinExt700 from "@fontsource/inter/files/inter-latin-ext-700-normal.woff2?url";
import interRanges from "@fontsource/inter/unicode.json";
import jetbrainsMonoLatin400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import jetbrainsMonoLatin700 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url";
import jetbrainsMonoLatinExt400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-400-normal.woff2?url";
import jetbrainsMonoLatinExt700 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-700-normal.woff2?url";
import jetbrainsMonoRanges from "@fontsource/jetbrains-mono/unicode.json";
import oswaldLatin400 from "@fontsource/oswald/files/oswald-latin-400-normal.woff2?url";
import oswaldLatin700 from "@fontsource/oswald/files/oswald-latin-700-normal.woff2?url";
import oswaldLatinExt400 from "@fontsource/oswald/files/oswald-latin-ext-400-normal.woff2?url";
import oswaldLatinExt700 from "@fontsource/oswald/files/oswald-latin-ext-700-normal.woff2?url";
import oswaldRanges from "@fontsource/oswald/unicode.json";
import sourceSerif4Latin400 from "@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2?url";
import sourceSerif4Latin700 from "@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff2?url";
import sourceSerif4LatinExt400 from "@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-normal.woff2?url";
import sourceSerif4LatinExt700 from "@fontsource/source-serif-4/files/source-serif-4-latin-ext-700-normal.woff2?url";
import sourceSerif4Ranges from "@fontsource/source-serif-4/unicode.json";

// The card fonts (contracts/card-generator.md#fonts), self-hosted: Vite emits each WOFF2
// file into the build, the service worker precaches it, so cards draw with the same fonts
// offline. Licenses: public/licenses/fonts/.

type Ranges = Partial<Record<CardFontSubset, string>>;

function face(
  font: CardFontId,
  subset: CardFontSubset,
  weight: CardFontWeight,
  source: string,
  ranges: Ranges,
): CardFontFace {
  const unicodeRange = ranges[subset];
  if (!unicodeRange) throw new Error(`No ${subset} range for ${font}`);
  return { font, weight, unicodeRange, source };
}

/** Every bundled face: six fonts, Latin and Latin Extended, regular and bold. */
export const CARD_FONT_FACES: readonly CardFontFace[] = [
  face("inter", "latin", 400, interLatin400, interRanges),
  face("inter", "latin", 700, interLatin700, interRanges),
  face("inter", "latin-ext", 400, interLatinExt400, interRanges),
  face("inter", "latin-ext", 700, interLatinExt700, interRanges),
  face(
    "atkinson-hyperlegible",
    "latin",
    400,
    atkinsonHyperlegibleLatin400,
    atkinsonHyperlegibleRanges,
  ),
  face(
    "atkinson-hyperlegible",
    "latin",
    700,
    atkinsonHyperlegibleLatin700,
    atkinsonHyperlegibleRanges,
  ),
  face(
    "atkinson-hyperlegible",
    "latin-ext",
    400,
    atkinsonHyperlegibleLatinExt400,
    atkinsonHyperlegibleRanges,
  ),
  face(
    "atkinson-hyperlegible",
    "latin-ext",
    700,
    atkinsonHyperlegibleLatinExt700,
    atkinsonHyperlegibleRanges,
  ),
  face("source-serif-4", "latin", 400, sourceSerif4Latin400, sourceSerif4Ranges),
  face("source-serif-4", "latin", 700, sourceSerif4Latin700, sourceSerif4Ranges),
  face("source-serif-4", "latin-ext", 400, sourceSerif4LatinExt400, sourceSerif4Ranges),
  face("source-serif-4", "latin-ext", 700, sourceSerif4LatinExt700, sourceSerif4Ranges),
  face("cinzel", "latin", 400, cinzelLatin400, cinzelRanges),
  face("cinzel", "latin", 700, cinzelLatin700, cinzelRanges),
  face("cinzel", "latin-ext", 400, cinzelLatinExt400, cinzelRanges),
  face("cinzel", "latin-ext", 700, cinzelLatinExt700, cinzelRanges),
  face("oswald", "latin", 400, oswaldLatin400, oswaldRanges),
  face("oswald", "latin", 700, oswaldLatin700, oswaldRanges),
  face("oswald", "latin-ext", 400, oswaldLatinExt400, oswaldRanges),
  face("oswald", "latin-ext", 700, oswaldLatinExt700, oswaldRanges),
  face("jetbrains-mono", "latin", 400, jetbrainsMonoLatin400, jetbrainsMonoRanges),
  face("jetbrains-mono", "latin", 700, jetbrainsMonoLatin700, jetbrainsMonoRanges),
  face("jetbrains-mono", "latin-ext", 400, jetbrainsMonoLatinExt400, jetbrainsMonoRanges),
  face("jetbrains-mono", "latin-ext", 700, jetbrainsMonoLatinExt700, jetbrainsMonoRanges),
];

let loading: Promise<void> | null = null;

/**
 * Loads the card fonts into the page once. Previews and generation wait for it, so text is
 * never measured or drawn with a system font. A failed load can be retried.
 */
export function ensureCardFonts(): Promise<void> {
  loading ??= loadCardFonts(CARD_FONT_FACES, document.fonts).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
