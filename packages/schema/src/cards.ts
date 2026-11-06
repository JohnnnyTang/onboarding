import { z } from "zod";
import { DefinitionIdSchema, ImageAssetRefSchema, IsoTimeSchema, unique } from "./common.js";

// Card generator data (contracts/card-generator.md): layout templates and imported CSV
// tables, stored with a local project. Lengths are millimeters and may have decimals; they
// are declarations, never match state.

export const MAX_TEMPLATE_FIELDS = 40;
export const MAX_CSV_COLUMNS = 100;
export const MAX_CSV_ROWS = 2000;
export const MAX_CSV_CELL_LENGTH = 2000;

/** `#rgb` or `#rrggbb`. Named CSS colors are not accepted, so every value means one color. */
export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Colors are written #rgb or #rrggbb");

/** Fonts bundled with the app (SIL Open Font License), named by their Fontsource ids. */
export const CARD_FONT_IDS = [
  "inter",
  "atkinson-hyperlegible",
  "source-serif-4",
  "cinzel",
  "oswald",
  "jetbrains-mono",
] as const;

/**
 * A bundled font. The generic names are aliases kept for templates saved before fonts were
 * bundled: sans-serif = Inter, serif = Source Serif 4, monospace = JetBrains Mono.
 */
export const CardFontSchema = z.enum([...CARD_FONT_IDS, "sans-serif", "serif", "monospace"]);
export type CardFont = z.infer<typeof CardFontSchema>;

const OffsetSchema = z.number().min(0).max(1000);
const ExtentSchema = z.number().positive().max(1000);

/** x, y = the field's top-left corner, from the card's top-left corner; y grows downward. */
export const CardFieldRectSchema = z.strictObject({
  x: OffsetSchema,
  y: OffsetSchema,
  w: ExtentSchema,
  h: ExtentSchema,
});

const FieldBase = {
  id: DefinitionIdSchema.max(40),
  label: z.string().min(1).max(40),
  rect_mm: CardFieldRectSchema,
};

export const CardTextFieldSchema = z.strictObject({
  ...FieldBase,
  kind: z.literal("text"),
  /** Text when no column is mapped, or when the row's cell is empty. "\n" breaks a line. */
  text: z.string().max(MAX_CSV_CELL_LENGTH),
  /** Font size (em height) in mm. Text that does not fit shrinks, down to half this size. */
  size_mm: z.number().positive().max(200),
  color: HexColorSchema,
  font: CardFontSchema,
  bold: z.boolean(),
  align: z.enum(["left", "center", "right"]),
  valign: z.enum(["top", "middle", "bottom"]),
});
export type CardTextField = z.infer<typeof CardTextFieldSchema>;

export const CardImageFieldSchema = z.strictObject({
  ...FieldBase,
  kind: z.literal("image"),
  /** Image when no column is mapped or the cell is empty; null draws nothing. */
  image: ImageAssetRefSchema.nullable(),
  fit: z.enum(["contain", "cover"]),
});
export type CardImageField = z.infer<typeof CardImageFieldSchema>;

export const CardBoxFieldSchema = z.strictObject({
  ...FieldBase,
  kind: z.literal("box"),
  /** Fill when no column is mapped or the cell is not a valid color. */
  color: HexColorSchema,
  radius_mm: z.number().min(0).max(500),
});
export type CardBoxField = z.infer<typeof CardBoxFieldSchema>;

export const CardFieldSchema = z.discriminatedUnion("kind", [
  CardTextFieldSchema,
  CardImageFieldSchema,
  CardBoxFieldSchema,
]);
export type CardField = z.infer<typeof CardFieldSchema>;

const ColumnNameSchema = z.string().min(1).max(80);

/** Which CSV table fills a template, and which of its columns fill which fields. */
export const CardTemplateDataSchema = z.strictObject({
  /** A `CsvSource` id of the same project; null generates one card from the defaults. */
  source: z.uuid().nullable(),
  /** Field id → column name. */
  columns: z.record(DefinitionIdSchema, ColumnNameSchema),
  /** Column whose cells, made into slugs, become the card ids. */
  idColumn: ColumnNameSchema.nullable(),
  /** Column whose cells become the card names. */
  nameColumn: ColumnNameSchema.nullable(),
  /** Column whose cells (whole numbers ≥ 1) say how many copies setup places. */
  countColumn: ColumnNameSchema.nullable(),
});
export type CardTemplateData = z.infer<typeof CardTemplateDataSchema>;

export const CardTemplateSchema = z
  .strictObject({
    id: DefinitionIdSchema.max(40),
    name: z.string().min(1).max(80),
    size_mm: z.tuple([z.number().positive().max(500), z.number().positive().max(500)]),
    background: HexColorSchema,
    /** Fields in drawing order: later fields are drawn over earlier ones. */
    fields: z.array(CardFieldSchema).max(MAX_TEMPLATE_FIELDS),
    /** `CardBackDef` id given to generated cards; null uses the project's first back. */
    back: DefinitionIdSchema.nullable(),
    data: CardTemplateDataSchema,
    /** Card definitions the last generation made, replaced by the next one. */
    generated: z.array(DefinitionIdSchema),
  })
  .refine((template) => unique(template.fields.map((field) => field.id)), {
    message: "Field ids must be unique",
    path: ["fields"],
  })
  .refine(
    (template) =>
      Object.keys(template.data.columns).every((id) =>
        template.fields.some((field) => field.id === id),
      ),
    { message: "Column mappings must name fields of the template", path: ["data", "columns"] },
  )
  .refine((template) => unique(template.generated), {
    message: "Generated ids must be unique",
    path: ["generated"],
  });
export type CardTemplate = z.infer<typeof CardTemplateSchema>;

/** An imported CSV file: the header row as columns, then the rows as text cells. */
export const CsvSourceSchema = z
  .strictObject({
    id: z.uuid(),
    /** The imported file's name. */
    name: z.string().min(1).max(120),
    columns: z.array(ColumnNameSchema).min(1).max(MAX_CSV_COLUMNS),
    rows: z.array(z.array(z.string().max(MAX_CSV_CELL_LENGTH))).max(MAX_CSV_ROWS),
    importedAt: IsoTimeSchema,
  })
  .refine((source) => unique(source.columns), {
    message: "Column names must be unique",
    path: ["columns"],
  })
  .refine((source) => source.rows.every((row) => row.length === source.columns.length), {
    message: "Every row needs one cell per column",
    path: ["rows"],
  });
export type CsvSource = z.infer<typeof CsvSourceSchema>;
