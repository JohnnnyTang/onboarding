import { z } from "zod";
import {
  type AssetRef,
  AssetRefSchema,
  DefinitionIdSchema,
  FaceSchema,
  IdSchema,
  ImageAssetRefSchema,
  IntegerSchema,
  JsonSchema,
  NonnegativeIntegerSchema,
  PositionSchema,
  PositiveIntegerSchema,
  RotationSchema,
  type SeatId,
  SeatIdSchema,
  unique,
} from "./common.js";

const LengthSchema = z.number().positive();
const SizeSchema = z.tuple([LengthSchema, LengthSchema]);
const DefBase = {
  id: DefinitionIdSchema,
  name: z.string().optional(),
  mass_g: z.number().nonnegative().optional(),
  material: z
    .strictObject({ preset: IdSchema, params: z.record(z.string(), JsonSchema).optional() })
    .optional(),
};
export const CardDefSchema = z.strictObject({
  ...DefBase,
  kind: z.literal("card"),
  size_mm: SizeSchema,
  thickness_mm: LengthSchema.optional(),
  corner_radius_mm: z.number().nonnegative().optional(),
  front: ImageAssetRefSchema,
  back: DefinitionIdSchema,
});
export type CardDef = z.infer<typeof CardDefSchema>;
export const CardBackDefSchema = z.strictObject({
  ...DefBase,
  kind: z.literal("cardBack"),
  image: ImageAssetRefSchema,
});
export type CardBackDef = z.infer<typeof CardBackDefSchema>;
export const TokenDefSchema = z.strictObject({
  ...DefBase,
  kind: z.literal("token"),
  shape: z.enum(["circle", "square", "rect", "hex"]),
  size_mm: SizeSchema,
  thickness_mm: LengthSchema.optional(),
  front: ImageAssetRefSchema,
  back: ImageAssetRefSchema.optional(),
});
export type TokenDef = z.infer<typeof TokenDefSchema>;
export const DieDefSchema = z
  .strictObject({
    ...DefBase,
    kind: z.literal("die"),
    sides: z.union([
      z.literal(4),
      z.literal(6),
      z.literal(8),
      z.literal(10),
      z.literal(12),
      z.literal(20),
    ]),
    size_mm: LengthSchema,
    faces: z
      .array(
        z
          .string()
          .refine(
            (face) =>
              !/\.(svg|png|jpe?g|webp|avif)(?:[?#].*)?$/i.test(face) ||
              ImageAssetRefSchema.safeParse(face).success,
            "Invalid die image asset",
          ),
      )
      .optional(),
    color: z.string().optional(),
  })
  .refine(
    (die) => die.faces === undefined || die.faces.length === die.sides,
    "One face per die side is required",
  );
export type DieDef = z.infer<typeof DieDefSchema>;
export const BoardDefSchema = z.strictObject({
  ...DefBase,
  kind: z.literal("board"),
  size_mm: SizeSchema,
  image: ImageAssetRefSchema,
});
export type BoardDef = z.infer<typeof BoardDefSchema>;
export const PieceDefSchema = z.strictObject({
  ...DefBase,
  kind: z.literal("piece"),
  size_mm: z.tuple([LengthSchema, LengthSchema, LengthSchema]),
  image: ImageAssetRefSchema,
  model: AssetRefSchema.optional(),
});
export type PieceDef = z.infer<typeof PieceDefSchema>;
export const ComponentDefSchema = z.discriminatedUnion("kind", [
  CardDefSchema,
  CardBackDefSchema,
  TokenDefSchema,
  DieDefSchema,
  BoardDefSchema,
  PieceDefSchema,
]);
export type ComponentDef = z.infer<typeof ComponentDefSchema>;
export const LayoutSchema = z.enum(["stack", "row", "fan", "grid", "free"]);
const RectSchema = z.strictObject({
  x: IntegerSchema,
  y: IntegerSchema,
  w: PositiveIntegerSchema,
  h: PositiveIntegerSchema,
});
const GridSchema = z.strictObject({ cols: PositiveIntegerSchema, rows: PositiveIntegerSchema });
const ZoneBase = {
  id: IdSchema,
  layout: LayoutSchema,
  label: z.string().optional(),
  grid: GridSchema.optional(),
};
export const ZoneDefSchema = z
  .strictObject({
    ...ZoneBase,
    rect_mm: z.strictObject({ x: z.number(), y: z.number(), w: LengthSchema, h: LengthSchema }),
    owner: z.union([SeatIdSchema, z.literal("each")]).optional(),
    visibility: z.enum(["public", "owner"]),
  })
  .refine(
    (zone) => zone.layout === "grid" || zone.grid === undefined,
    "Grid is only valid for grid layout",
  )
  .refine(
    (zone) => zone.visibility !== "owner" || zone.owner !== undefined,
    "Owner visibility needs an owner",
  );
export type ZoneDef = z.infer<typeof ZoneDefSchema>;
export const ZonePlacementSchema = z
  .strictObject({
    ...ZoneBase,
    rect_mm: RectSchema,
    owner: SeatIdSchema.optional(),
    droppable: z.boolean().optional(),
  })
  .refine(
    (zone) => zone.layout === "grid" || zone.grid === undefined,
    "Grid is only valid for grid layout",
  );
export type ZonePlacement = z.infer<typeof ZonePlacementSchema>;
export const ItemPlacementSchema = z.strictObject({
  id: IdSchema,
  zone: IdSchema,
  index: NonnegativeIntegerSchema.optional(),
  pos_mm: PositionSchema.optional(),
  rotation_deg: RotationSchema.optional(),
  face: FaceSchema,
  def: DefinitionIdSchema.optional(),
  back: DefinitionIdSchema.optional(),
  value: PositiveIntegerSchema.optional(),
  selectable: z.boolean().optional(),
  draggable: z.boolean().optional(),
  highlight: z.enum(["legal", "selected", "warning"]).optional(),
  badge: z.string().optional(),
});
export type ItemPlacement = z.infer<typeof ItemPlacementSchema>;
export const HudEntrySchema = z.strictObject({
  seat: SeatIdSchema,
  name: z.string().optional(),
  score: IntegerSchema.optional(),
  handCount: NonnegativeIntegerSchema.optional(),
  active: z.boolean(),
});
export type HudEntry = z.infer<typeof HudEntrySchema>;
export const TableSnapshotSchema = z
  .strictObject({
    table: z.strictObject({ size_mm: z.tuple([PositiveIntegerSchema, PositiveIntegerSchema]) }),
    zones: z.array(ZonePlacementSchema),
    items: z.array(ItemPlacementSchema),
    hud: z.array(HudEntrySchema).optional(),
    prompt: z.string().optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (
      !unique(snapshot.zones.map((zone) => zone.id)) ||
      !unique(snapshot.items.map((item) => item.id))
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate zone or item ids" });
    }
    for (const [index, item] of snapshot.items.entries()) {
      const zone = snapshot.zones.find((candidate) => candidate.id === item.zone);
      if (!zone || (item.pos_mm !== undefined && zone.layout !== "free")) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Unknown zone or position outside a free zone",
        });
      }
      if (
        item.pos_mm &&
        (Math.abs(item.pos_mm[0]) * 2 > snapshot.table.size_mm[0] ||
          Math.abs(item.pos_mm[1]) * 2 > snapshot.table.size_mm[1])
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "pos_mm"],
          message: "Position outside the table",
        });
      }
    }
  });
export type TableSnapshot = z.infer<typeof TableSnapshotSchema>;
export const GestureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), item: IdSchema }),
  z.strictObject({ kind: z.literal("clickZone"), zone: IdSchema }),
  z.strictObject({
    kind: z.literal("drop"),
    item: IdSchema,
    from: IdSchema,
    to: IdSchema,
    index: NonnegativeIntegerSchema.optional(),
    pos_mm: PositionSchema.optional(),
  }),
]);
export type Gesture = z.infer<typeof GestureSchema>;
export const ManualOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("move"),
    item: IdSchema,
    to: IdSchema,
    index: NonnegativeIntegerSchema.optional(),
    pos_mm: PositionSchema.optional(),
    face: FaceSchema.optional(),
  }),
  z.strictObject({ op: z.literal("flip"), item: IdSchema }),
  z.strictObject({ op: z.literal("rotate"), item: IdSchema, deg: RotationSchema }),
  z.strictObject({ op: z.literal("shuffle"), zone: IdSchema }),
  z.strictObject({
    op: z.literal("deal"),
    from: IdSchema,
    to: z.array(IdSchema).min(1),
    count: PositiveIntegerSchema,
    face: FaceSchema.optional(),
  }),
  z.strictObject({ op: z.literal("roll"), item: IdSchema }),
  z.strictObject({ op: z.literal("endTurn") }),
]);
export type ManualOp = z.infer<typeof ManualOpSchema>;
export const SandboxSetupSchema = z.strictObject({
  instances: z.array(
    z.strictObject({
      def: DefinitionIdSchema,
      zone: IdSchema,
      count: PositiveIntegerSchema.optional(),
      face: FaceSchema.optional(),
      shuffle: z.boolean().optional(),
    }),
  ),
});
export type SandboxSetup = z.infer<typeof SandboxSetupSchema>;
export const SandboxStateSchema = z
  .strictObject({
    items: z.array(
      z.strictObject({
        id: IdSchema,
        def: DefinitionIdSchema,
        zone: IdSchema,
        index: NonnegativeIntegerSchema,
        pos_mm: PositionSchema.optional(),
        rotation_deg: RotationSchema,
        face: FaceSchema,
        value: PositiveIntegerSchema.optional(),
      }),
    ),
  })
  .refine((state) => unique(state.items.map((item) => item.id)), "Duplicate item ids")
  .refine(
    (state) => JsonSchema.safeParse(state).success,
    "Sandbox state must contain only integer JSON",
  );
export type SandboxState = {
  items: {
    id: string;
    def: string;
    zone: string;
    index: number;
    pos_mm?: [number, number];
    rotation_deg: number;
    face: "up" | "down";
    value?: number;
  }[];
};
/** Public sandbox data; hidden items omit identity and value. */
export const SandboxViewSchema = z
  .strictObject({
    items: z.array(
      SandboxStateSchema.shape.items.element.omit({ def: true }).extend({
        def: DefinitionIdSchema.optional(),
        back: DefinitionIdSchema.optional(),
      }),
    ),
  })
  .refine(
    (view) => JsonSchema.safeParse(view).success,
    "Sandbox view must contain only integer JSON",
  );
export type SandboxView = {
  items: (Omit<SandboxState["items"][number], "def"> & { def?: string; back?: string })[];
};
export const ComponentsFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    defs: z.array(ComponentDefSchema),
    zones: z.array(ZoneDefSchema).optional(),
    setup: SandboxSetupSchema.optional(),
  })
  .superRefine((file, ctx) => {
    if (
      !unique(file.defs.map((def) => def.id)) ||
      !unique((file.zones ?? []).map((zone) => zone.id))
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate component or zone ids" });
    }
    for (const [index, def] of file.defs.entries()) {
      if (
        def.kind === "card" &&
        !file.defs.some((back) => back.id === def.back && back.kind === "cardBack")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["defs", index, "back"],
          message: "Unknown card back",
        });
      }
    }
    for (const [index, instance] of (file.setup?.instances ?? []).entries()) {
      if (
        !file.defs.some((def) => def.id === instance.def) ||
        !file.zones?.some(
          (zone) =>
            zone.id === instance.zone ||
            (zone.owner === "each" &&
              instance.zone.startsWith(`${zone.id}:`) &&
              SeatIdSchema.safeParse(instance.zone.slice(zone.id.length + 1)).success),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["setup", "instances", index],
          message: "Unknown setup component or zone",
        });
      }
    }
  });
export type ComponentsFile = z.infer<typeof ComponentsFileSchema>;

/** Visibility needs game knowledge; use this schema at the presentation boundary. */
export function tableSnapshotForSeatSchema(context: {
  components: ComponentsFile;
  canIdentify(item: ItemPlacement): boolean;
  isCard?(item: ItemPlacement): boolean;
}) {
  return TableSnapshotSchema.superRefine((snapshot, ctx) => {
    for (const [index, item] of snapshot.items.entries()) {
      const def = context.components.defs.find((candidate) => candidate.id === item.def);
      if (!context.canIdentify(item) && item.def !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "def"],
          message: "Hidden items must omit def",
        });
      }
      if (item.def !== undefined && !def) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "def"],
          message: "Unknown component",
        });
      }
      if (
        item.back !== undefined &&
        !context.components.defs.some(
          (candidate) => candidate.kind === "cardBack" && candidate.id === item.back,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "back"],
          message: "Unknown card back",
        });
      }
      if (item.def === undefined && context.isCard?.(item) && item.back === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "back"],
          message: "Hidden cards require a back",
        });
      }
      if (item.value !== undefined && def && (def.kind !== "die" || item.value > def.sides)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "value"],
          message: "Invalid die value",
        });
      }
    }
  });
}

export function sandboxSnapshotForSeatSchema(
  components: ComponentsFile,
  seat: SeatId | null,
  isCard?: (item: ItemPlacement) => boolean,
) {
  return tableSnapshotForSeatSchema({
    components,
    ...(isCard ? { isCard } : {}),
    canIdentify(item) {
      const zone = components.zones?.find(
        (candidate) =>
          candidate.id === item.zone ||
          (candidate.owner === "each" &&
            item.zone.startsWith(`${candidate.id}:`) &&
            SeatIdSchema.safeParse(item.zone.slice(candidate.id.length + 1)).success),
      );
      if (!zone) return false;
      const owner = zone.owner === "each" ? item.zone.slice(zone.id.length + 1) : zone.owner;
      return zone.visibility === "owner" ? seat !== null && owner === seat : item.face === "up";
    },
  });
}

// Keeping the host element generic lets this pure package compile without DOM libraries.
export interface TableRenderer<Container> {
  mount(
    container: Container,
    init: { components: ComponentsFile; assetUrl(ref: AssetRef): string; seat: SeatId | null },
  ): Promise<void>;
  setSnapshot(snapshot: TableSnapshot): void;
  onGesture(handler: (gesture: Gesture) => void): () => void;
  onSelectionChange(handler: (ids: string[]) => void): () => void;
  setSelection(ids: string[]): void;
  resize(): void;
  destroy(): void;
}
