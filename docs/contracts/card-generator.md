# Contract: card generator

How a designer's card layout template and CSV rows become card faces. The data lives in a
local project (`cardTemplates` and `csvSources` in [data-model.md](../data-model.md#browser-indexeddb-bgp-database));
`@bgp/card-generator` draws it. Implemented in `@bgp/schema` (`CardTemplateSchema`,
`CsvSourceSchema`).

## Card template

```ts
export interface CardTemplate {
  id: string; // [a-z0-9-], unique within the project
  name: string;
  size_mm: [number, number]; // card width, height; becomes the generated cards' size_mm
  background: HexColor; // "#rgb" or "#rrggbb"
  fields: CardField[]; // drawing order: later fields are drawn over earlier ones
  back: string | null; // CardBackDef id for generated cards; null = the project's first back
  data: CardTemplateData;
  generated: string[]; // card def ids the last generation made
}

export type CardField = CardTextField | CardImageField | CardBoxField;

interface FieldBase {
  id: string; // [a-z0-9-], unique within the template
  label: string; // shown in the editor
  rect_mm: { x: number; y: number; w: number; h: number }; // x, y = top-left corner
}

export interface CardTextField extends FieldBase {
  kind: "text";
  text: string; // default text; "\n" breaks a line
  size_mm: number; // font size (em height)
  color: HexColor;
  font: CardFont; // a bundled font, see Fonts
  bold: boolean;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
}

export interface CardImageField extends FieldBase {
  kind: "image";
  image: AssetRef | null; // default image; null draws nothing
  fit: "contain" | "cover";
}

export interface CardBoxField extends FieldBase {
  kind: "box";
  color: HexColor; // default fill
  radius_mm: number; // corner radius
}

export interface CardTemplateData {
  source: string | null; // CsvSource id; null generates one card from the defaults
  columns: Record<string, string>; // field id → column name
  idColumn: string | null;
  nameColumn: string | null;
  countColumn: string | null;
}
```

### Layout

- Card coordinates start at the card's **top-left corner**; `x` grows to the right and `y`
  grows **downward**. Units are millimeters and may have decimals (they are declarations,
  not match state). A field may extend past the card; whatever is outside is cut off.
- Rendering at `dpi` dots per inch uses `px = mm × dpi / 25.4`. Card faces are rendered at
  **300 dpi**; the canvas is `round(width × 300 / 25.4)` by `round(height × 300 / 25.4)`
  pixels (744 × 1039 for 63 × 88 mm). Previews use the same layout at a lower dpi.
- The background fills the whole card. Fields are drawn in order, each clipped to its
  rectangle.
- **Text** wraps at spaces to the field width and breaks at `"\n"`; a word longer than the
  width is broken between characters. When the lines do not fit the field, the size shrinks
  in steps of 5 % down to half of `size_mm`; lines that still do not fit are cut off. Line
  height is 1.2 × the size, in the field's bundled font (see Fonts).
- **Image**: `contain` shows the whole image inside the field, centered; `cover` fills the
  field and crops the overflow, centered. A missing image draws nothing.
- **Box**: a filled rectangle with rounded corners (radius capped at half the shorter side).

### Fonts

Text is drawn only with fonts bundled with the app, so a card looks the same on every system
and generation works offline. All are under the SIL Open Font License 1.1; the app ships
them as self-hosted WOFF2 files (Latin and Latin Extended subsets, regular 400 and bold
700, from the pinned Fontsource packages) with their license texts under
`/licenses/fonts/`.

```ts
export type CardFont =
  | "inter" // sans serif, the default for new text fields
  | "atkinson-hyperlegible" // sans serif built for legibility, for rules text
  | "source-serif-4" // serif
  | "cinzel" // display capitals, for titles
  | "oswald" // condensed, for large numbers
  | "jetbrains-mono" // monospace
  | "sans-serif" // alias of inter
  | "serif" // alias of source-serif-4
  | "monospace"; // alias of jetbrains-mono
```

The generic names are aliases kept for templates saved before fonts were bundled; editors
offer only the six named fonts. Each face is registered under a family name of its own
(`"BGP Inter"`, …) so an installed font of the same name is never used, and previews and
generation wait until every face is loaded. Characters outside the bundled subsets (for
example Chinese) fall back to a system font; other scripts are left for after Phase 1.

### Values from a CSV row

Each field mapped in `data.columns` takes its value from that column's cell in the row:

| Field   | Cell                                                                                             | Empty or unusable cell                                      |
| ------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `text`  | The text, as is                                                                                  | Empty: the field's `text`                                   |
| `image` | An imported image named by its path (`assets/fish.png`), file name (`fish.png`) or stem (`fish`) | Empty: the field's `image`; unknown name: nothing, reported |
| `box`   | A color, `#rgb` or `#rrggbb`                                                                     | Empty: the field's `color`; not a color: `color`, reported  |

A field without a mapping always uses its default. A mapping to a column the source does not
have is reported and ignored. Without a source, generation makes one card from the
defaults.

### Generated cards

Generation renders every row of the source to a PNG and stores it as a project image at
`assets/cards/<card id>.png`, then writes one `CardDef` per row:

- **id**: the slug of the `idColumn` cell (lowercase letters, digits and dashes, as project
  ids are made); without an `idColumn`, or for an empty cell, `<template id>-<row number>`
  (rows numbered from 1). Ids must be unique and must not belong to a component the template
  did not generate; otherwise nothing is generated and the conflicts are reported.
- **name**: the `nameColumn` cell, else `<template name> <row number>`.
- **size_mm**: the template's size. **front**: the generated image. **back**: the template's
  `back`, else the project's first card back (one is added if the project has none).

Cards the previous generation made (`generated`) but this one does not are removed, with
their images and setup lines. "Add to setup" places each generated card in a chosen zone,
`countColumn` copies of it (a whole number from 1 to 100; otherwise 1, reported).

<!-- schema: CardTemplateSchema -->
```json
{
  "id": "goods",
  "name": "Goods",
  "size_mm": [63, 88],
  "background": "#ffffff",
  "fields": [
    {
      "id": "frame",
      "label": "Frame",
      "kind": "box",
      "rect_mm": { "x": 0, "y": 0, "w": 63, "h": 88 },
      "color": "#2f6fb0",
      "radius_mm": 3
    },
    {
      "id": "title",
      "label": "Good",
      "kind": "text",
      "rect_mm": { "x": 4, "y": 3, "w": 55, "h": 10 },
      "text": "Good",
      "size_mm": 6,
      "color": "#ffffff",
      "font": "cinzel",
      "bold": true,
      "align": "center",
      "valign": "middle"
    },
    {
      "id": "art",
      "label": "Art",
      "kind": "image",
      "rect_mm": { "x": 4, "y": 14, "w": 55, "h": 60 },
      "image": null,
      "fit": "cover"
    }
  ],
  "back": "goods-back",
  "data": {
    "source": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
    "columns": { "frame": "color", "title": "name" },
    "idColumn": "id",
    "nameColumn": "name",
    "countColumn": null
  },
  "generated": []
}
```

## CSV source

```ts
export interface CsvSource {
  id: string; // UUID
  name: string; // the imported file's name
  columns: string[]; // from the header row: unique, not empty
  rows: string[][]; // one cell per column, as text
  importedAt: string; // ISO 8601
}
```

The web app parses files with Papa Parse: the first row is the header, fully empty rows are
skipped, cells are trimmed, a row with fewer cells is padded with empty cells and a row with
more is refused. Limits: 100 columns, 2,000 rows, 2,000 characters per cell, and a 1 MB
file. Importing a file with the name of an existing source replaces it; mappings to columns
the new file lacks are dropped.

<!-- schema: CsvSourceSchema -->
```json
{
  "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
  "name": "goods.csv",
  "columns": ["id", "name", "good", "value", "color"],
  "rows": [
    ["fish-1", "Fish 1", "fish", "1", "#2f6fb0"],
    ["salt-1", "Salt 1", "salt", "1", "#8a8f98"]
  ],
  "importedAt": "2026-11-04T10:00:00.000Z"
}
```
