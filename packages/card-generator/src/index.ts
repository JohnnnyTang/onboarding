// @bgp/card-generator: card layout templates plus CSV rows → card face PNGs
// (contracts/card-generator.md). Imports only types from @bgp/schema; callers validate
// templates with CardTemplateSchema before drawing them.

export {
  CARD_DPI,
  type CardContext,
  type CardImage,
  fontFor,
  layoutText,
  paintCard,
  pixelSize,
  pixelsPerMm,
  type TextLayout,
  wrapText,
} from "./paint.js";
export {
  CardRenderError,
  loadCardImages,
  type RenderOptions,
  renderCardPng,
  renderCardPngs,
} from "./render.js";
export {
  type CardPlan,
  type CardRows,
  type CardValues,
  cardSlug,
  defaultValues,
  findImage,
  MAX_COPIES,
  missingColumns,
  type PlannedCard,
  planCards,
  type RowValues,
  rowValues,
} from "./values.js";
