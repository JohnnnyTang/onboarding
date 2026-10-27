import { z } from "zod";
import {
  IdSchema,
  IntegerSchema,
  type Json,
  JsonSchema,
  SlugSchema,
  unique,
  VersionPathSchema,
} from "./common.js";
import { type ComponentsFile, ComponentsFileSchema } from "./table.js";

export const SemanticVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
export const BooleanOptionSchema = z.strictObject({
  id: IdSchema,
  label: z.string(),
  type: z.literal("boolean"),
  default: z.boolean(),
});
export const IntegerOptionSchema = z
  .strictObject({
    id: IdSchema,
    label: z.string(),
    type: z.literal("integer"),
    default: IntegerSchema,
    min: IntegerSchema,
    max: IntegerSchema,
  })
  .refine(
    (option) => option.min <= option.default && option.default <= option.max,
    "Default must be inside the integer range",
  );
export const ChoiceOptionSchema = z
  .strictObject({
    id: IdSchema,
    label: z.string(),
    type: z.literal("choice"),
    default: z.string(),
    choices: z.array(z.string()).min(1).refine(unique),
  })
  .refine((option) => option.choices.includes(option.default), "Default must be a declared choice");
export const ManifestOptionSchema = z.discriminatedUnion("type", [
  BooleanOptionSchema,
  IntegerOptionSchema,
  ChoiceOptionSchema,
]);
export type ManifestOption = z.infer<typeof ManifestOptionSchema>;
const ManifestBase = {
  schemaVersion: z.literal(1),
  id: SlugSchema,
  name: z.string().min(1).max(80),
  version: SemanticVersionSchema,
  sdk: z.literal(1),
  players: z
    .strictObject({ min: IntegerSchema.min(1).max(8), max: IntegerSchema.min(1).max(8) })
    .refine((players) => players.min <= players.max, "Player range is reversed"),
  components: VersionPathSchema,
  options: z
    .array(ManifestOptionSchema)
    .refine((options) => unique(options.map((option) => option.id)), "Duplicate option ids")
    .optional(),
  description: z.string().optional(),
  authors: z.array(z.string()).optional(),
  license: z.string().optional(),
};
export const ManifestSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...ManifestBase, mode: z.literal("enforced"), entry: VersionPathSchema }),
  z.strictObject({ ...ManifestBase, mode: z.literal("sandbox") }),
]);
export type Manifest = z.infer<typeof ManifestSchema>;
export const GamePackageSchema = z
  .strictObject({ manifest: ManifestSchema, components: ComponentsFileSchema })
  .refine(
    ({ manifest, components }) =>
      manifest.mode !== "sandbox" ||
      (components.zones !== undefined && components.setup !== undefined),
    "Sandbox games require zones and setup",
  )
  .refine(
    ({ manifest, components }) => manifest.mode !== "enforced" || components.setup === undefined,
    "Setup declarations are only valid in sandbox mode",
  );
export type GamePackage = z.infer<typeof GamePackageSchema>;

/** Validate supplied values; defaults are applied by the runtime, never by parsing. */
export function optionsForManifestSchema(manifest: Manifest) {
  const entries = (manifest.options ?? []).map((option): [string, z.ZodType] => {
    switch (option.type) {
      case "boolean":
        return [option.id, z.boolean()];
      case "integer":
        return [option.id, IntegerSchema.min(option.min).max(option.max)];
      case "choice":
        return [option.id, z.enum(option.choices)];
    }
    throw new Error("Unsupported option type");
  });
  const fields = z.strictObject(Object.fromEntries(entries));
  return z.custom<Record<string, Json>>(
    (values) => JsonSchema.safeParse(values).success && fields.safeParse(values).success,
    "Expected the complete, declared manifest options",
  );
}

/** References for finalize; ambiguous die strings are images when they have an image extension. */
export function componentAssetRefs(components: ComponentsFile): string[] {
  const refs: string[] = [];
  for (const def of components.defs) {
    switch (def.kind) {
      case "card":
        refs.push(def.front);
        break;
      case "cardBack":
      case "board":
        refs.push(def.image);
        break;
      case "token":
        refs.push(def.front);
        if (def.back) refs.push(def.back);
        break;
      case "piece":
        refs.push(def.image);
        if (def.model) refs.push(def.model);
        break;
      case "die":
        refs.push(...(def.faces ?? []).filter((face) => /\.(png|jpe?g|webp|avif)$/i.test(face)));
        break;
    }
  }
  return refs;
}
