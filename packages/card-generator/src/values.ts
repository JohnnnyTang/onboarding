import type { CardTemplate, CsvSource } from "@bgp/schema";

// Which value each field shows for one CSV row, and which cards a template generates
// (contracts/card-generator.md). Pure functions: no canvas, no storage.

/** Field id → value: text for text fields, an image path or null, a color for boxes. */
export type CardValues = Readonly<Record<string, string | null>>;

/** The parts of a CSV source the generator reads. */
export type CardRows = Pick<CsvSource, "columns" | "rows">;

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const MAX_COPIES = 100;

/**
 * The imported image a cell names: its path ("assets/fish.png"), file name ("fish.png") or
 * stem ("fish"), compared without case. Null when no image matches.
 */
export function findImage(name: string, images: readonly string[]): string | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return null;
  const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const stem = (path: string) => fileName(path).replace(/\.[^.]*$/, "");
  return (
    images.find((path) => path.toLowerCase() === wanted) ??
    images.find((path) => fileName(path) === wanted) ??
    images.find((path) => stem(path) === wanted) ??
    null
  );
}

/** The template's own values, used when no row is given. */
export function defaultValues(template: CardTemplate): CardValues {
  const values: Record<string, string | null> = {};
  for (const field of template.fields) {
    values[field.id] =
      field.kind === "text" ? field.text : field.kind === "image" ? field.image : field.color;
  }
  return values;
}

/** Column mappings that name a column the source does not have. */
export function missingColumns(template: CardTemplate, source: CardRows): string[] {
  const named = [
    ...Object.values(template.data.columns),
    template.data.idColumn,
    template.data.nameColumn,
    template.data.countColumn,
  ];
  return [
    ...new Set(
      named.filter(
        (column): column is string => column !== null && !source.columns.includes(column),
      ),
    ),
  ];
}

function cell(source: CardRows, row: readonly string[], column: string | null): string {
  if (column === null) return "";
  const index = source.columns.indexOf(column);
  return index < 0 ? "" : (row[index] ?? "").trim();
}

export interface RowValues {
  values: CardValues;
  /** Cells that could not be used; their fields fall back as the contract says. */
  warnings: string[];
}

/** The values of row `index` (0-based) of `source`. */
export function rowValues(
  template: CardTemplate,
  source: CardRows,
  index: number,
  images: readonly string[],
): RowValues {
  const values: Record<string, string | null> = { ...defaultValues(template) };
  const warnings: string[] = [];
  const row = source.rows[index] ?? [];
  for (const field of template.fields) {
    const column = template.data.columns[field.id];
    if (column === undefined || !source.columns.includes(column)) continue;
    const text = cell(source, row, column);
    if (text === "") continue;
    const where = `Row ${index + 1}, ${column}`;
    if (field.kind === "text") {
      values[field.id] = cell(source, row, column);
    } else if (field.kind === "image") {
      const image = findImage(text, images);
      if (image === null) warnings.push(`${where}: no imported image is named "${text}"`);
      values[field.id] = image;
    } else if (COLOR.test(text)) {
      values[field.id] = text;
    } else {
      warnings.push(`${where}: "${text}" is not a color like #2f6fb0`);
    }
  }
  return { values, warnings };
}

/** "Fish 1!" → "fish-1": a component id, or "" when nothing usable is left. */
export function cardSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export interface PlannedCard {
  /** 0-based row of the source, or null for the single card of a template without one. */
  row: number | null;
  id: string;
  name: string;
  /** Copies setup places. */
  count: number;
  values: CardValues;
}

export interface CardPlan {
  cards: PlannedCard[];
  /** Problems that stop generation (duplicate ids). */
  errors: string[];
  /** Problems reported while generating anyway. */
  warnings: string[];
}

/** The cards a template generates from its rows, with their ids, names and values. */
export function planCards(
  template: CardTemplate,
  source: CardRows | null,
  images: readonly string[],
): CardPlan {
  if (source === null) {
    return {
      cards: [
        {
          row: null,
          id: `${template.id}-1`,
          name: template.name,
          count: 1,
          values: defaultValues(template),
        },
      ],
      errors: [],
      warnings: [],
    };
  }
  const warnings = missingColumns(template, source).map(
    (column) => `The CSV has no column "${column}"; it is ignored`,
  );
  const errors: string[] = [];
  const cards: PlannedCard[] = [];
  const rows = new Map<string, number>();
  for (const [index, row] of source.rows.entries()) {
    const number = index + 1;
    const slug = cardSlug(cell(source, row, template.data.idColumn));
    const id = slug === "" ? `${template.id}-${number}` : slug;
    const earlier = rows.get(id);
    if (earlier !== undefined) {
      errors.push(`Rows ${earlier} and ${number} would both make the card "${id}"`);
    } else {
      rows.set(id, number);
    }
    const name = cell(source, row, template.data.nameColumn) || `${template.name} ${number}`;
    const countText = cell(source, row, template.data.countColumn);
    let count = 1;
    if (template.data.countColumn !== null && source.columns.includes(template.data.countColumn)) {
      const parsed = Number(countText);
      if (/^\d+$/.test(countText) && parsed >= 1 && parsed <= MAX_COPIES) count = parsed;
      else
        warnings.push(
          `Row ${number}, ${template.data.countColumn}: "${countText}" is not a whole number from 1 to ${MAX_COPIES}; 1 copy`,
        );
    }
    const resolved = rowValues(template, source, index, images);
    warnings.push(...resolved.warnings);
    cards.push({ row: index, id, name: name.slice(0, 80), count, values: resolved.values });
  }
  return { cards, errors, warnings };
}
