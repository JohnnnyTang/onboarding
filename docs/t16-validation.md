# T16 validation: card generator

Completed on 2026-11-04 on the `claude/t16-card-generator` branch, based on `66824b7` (T15
merged).

## Delivered

- **Contracts** ([contracts/card-generator.md](contracts/card-generator.md)). `CardTemplateSchema`
  (text, image and box fields in millimeters from the card's top-left corner, a column
  mapping, the card back and the ids it generated last) and `CsvSourceSchema` (header and
  text rows) replace the untyped `cardTemplates` and `csvSources` arrays of a local project.
  A template must name a source of the same project. The contract defines layout, 300 dpi
  rendering, text wrapping and shrink-to-fit, how cells fill fields and how generated cards
  are named. JSON Schemas regenerated; the contract's examples are checked.
- **`@bgp/card-generator`**. `values.ts` resolves each field from a row (text, an imported
  image named by path, file name or stem, or a `#rgb`/`#rrggbb` color) and plans card ids,
  names and copy counts, reporting unusable cells and duplicate ids. `paint.ts` draws a
  template with Canvas 2D; `render.ts` encodes 300 dpi PNGs, four at a time, on an
  `OffscreenCanvas` or, where the browser has none, a page `<canvas>`. The package imports
  only types from `@bgp/schema`.
- **Cards section** (`/projects/:id/cards`). CSV import through Papa Parse behind
  `parseCsv` (header row, trimmed cells, delimiter detection, 1 MB / 2,000 rows / 100
  columns; a file with the same name replaces its source and drops mappings to missing
  columns). Template editor: card size, background, back, CSV file, id/name/copies columns,
  fields (position, size, kind settings, column, drawing order). A live preview draws any
  row with the same code as generation and lists that row's warnings.
- **Generation**. Every row is rendered at 300 dpi; the faces (`assets/cards/<id>.png`) and
  the card components are saved in one IndexedDB transaction
  (`ProjectStore.putProjectWithAssets`). Regenerating replaces the template's own cards,
  removes stale ones with their faces and setup lines, and refuses ids of components made
  another way. "Add to setup" places the cards in a zone, face up or down, shuffled, with
  the copies column.
- **Harbor Market art**. `games/harbor-market/art/templates.json` (goods and back templates)
  and `art/goods.csv` (15 rows) are drawn by `pnpm art:harbor` in headless Chromium into the
  16 committed PNGs (744 × 1039 px, about 0.8 MB). A test checks they are exactly the images
  `components.json` uses; the E2E fixture now uploads them instead of a 1 × 1 placeholder.
- **Dependencies**: `papaparse` 5.7.0 and `@types/papaparse` 5.5.2 (dev), recorded in
  tech-stack.md and admitted for `apps/web` by the boundary check.

## Things found and fixed on the way

- **WebKit has no OffscreenCanvas** in Playwright's Windows build, so generation threw
  there. The generator falls back to a page `<canvas>` with the same drawing (Safari has
  had `OffscreenCanvas` since 16.4).
- **WebKit ephemeral contexts cannot keep Blobs in IndexedDB**, so image import fails in a
  plain Playwright WebKit context. The timing test uses a profile on disk, as E2E-01 does.
- **Stale drafts**: saving a template from a draft opened before a generation would have
  overwritten its list of generated cards; `updateTemplate` keeps the stored list.

## Checks

| Command                     | Evidence                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm build`                | 10 build tasks pass                                                                                    |
| `pnpm typecheck`            | All tasks plus root tooling pass                                                                       |
| `pnpm lint`                 | Biome and package-boundary checks pass                                                                 |
| `pnpm test`                 | 17 tasks and 60 tooling tests pass: 169 schema, 16 card-generator, 142 web, 127 server (`bgp_test`)    |
| `pnpm check:wasm`           | Passes; the web output has no WASM                                                                     |
| `pnpm test:e2e --workers=1` | 66 of 66 pass in Chromium, Firefox and WebKit (6.2 min), including E2E-01, E2E-04, E2E-05 and lockdown |

PostgreSQL ran on port 15432 because a native PostgreSQL holds 5432 on this machine.

**Done-when check.** `e2e/projects.spec.ts` runs E2E-01 in full in each browser, offline
from the first edit: images, a card and a die, then a ten-row CSV and a "Goods" template
with a color band, title and art mapped from columns; the preview's band shows row 4's color;
ten cards are generated and one stored face is read back from IndexedDB (PNG, 744 × 1039,
the CSV color). Zones are drawn, the generated cards go face down and shuffled into the deck,
and hot-seat play deals one to each hand: each seat knows only its own generated card, "All
seats" shows both and hides the deck, and after a browser restart the same hidden hands come
back. The second test generates 100 cards through the page and fails above 10 s:

| Browser  | 100 cards, click to saved |
| -------- | ------------------------- |
| Chromium | 0.9 s                     |
| Firefox  | 1.3 s                     |
| WebKit   | 3.9 s (page `<canvas>`)   |

## Not covered here

- Fonts are the browser's generic families only, so a template looks different per system
  (Q-023); generated PNGs are not byte-identical across machines (Q-024).
- Fields are positioned with numbers, not by dragging on the preview.
- Text color, font size and image fit cannot come from CSV columns; only text, images and
  box colors can.
- Generated cards are ordinary components: edits made to them under Components are
  replaced by the next generation (except thickness, corner radius and mass).
