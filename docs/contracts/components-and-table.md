# Contract: components and table

How physical things are declared, how a seat's table is described to a renderer, and how sandbox games are modeled. Implemented in `@bgp/schema`.

## Coordinates

- Units: millimeters for lengths, degrees for angles, grams for mass.
- Table origin at the **center of the table**. `x` grows to the right, `y` grows away from seat `"0"` (up the screen when seat `"0"` looks at the table). In 3D (Phase 2), the table plane is `y = 0` and table `y` maps to world `-z`.
- Rotation is clockwise seen from above, `0..359`.
- **In match state and in snapshots**, positions and rotations are integers. **In declarations**, sizes may have decimals (a card is 0.3 mm thick).
- Renderers may rotate the whole view so the viewing seat sits at the bottom; coordinates in data never change with the viewer.

## Components file

Every game version has `components.json`.

```ts
export interface ComponentsFile {
  schemaVersion: 1;
  defs: ComponentDef[];
  zones?: ZoneDef[]; // required in sandbox mode; optional for enforced games
  setup?: SandboxSetup; // sandbox mode only
}

export type ComponentDef = CardDef | CardBackDef | TokenDef | DieDef | BoardDef | PieceDef;

interface DefBase {
  id: string; // unique within the file, [a-z0-9-]
  name?: string;
  mass_g?: number;
  material?: { preset: string; params?: Record<string, Json> }; // reserved for Phase 2; ignored by table-2d
}

export interface CardDef extends DefBase {
  kind: "card";
  size_mm: [number, number]; // width, height, e.g. [63, 88]
  thickness_mm?: number; // default 0.3
  corner_radius_mm?: number; // default 3
  front: AssetRef;
  back: string; // id of a CardBackDef
}

export interface CardBackDef extends DefBase {
  kind: "cardBack";
  image: AssetRef;
}

export interface TokenDef extends DefBase {
  kind: "token";
  shape: "circle" | "square" | "rect" | "hex";
  size_mm: [number, number];
  thickness_mm?: number; // default 2
  front: AssetRef;
  back?: AssetRef; // defaults to front
}

export interface DieDef extends DefBase {
  kind: "die";
  sides: 4 | 6 | 8 | 10 | 12 | 20;
  size_mm: number; // edge or diameter
  faces?: (string | AssetRef)[]; // label or image per face; length = sides; default "1".."n"
  color?: string; // CSS color for table-2d
}

export interface BoardDef extends DefBase {
  kind: "board";
  size_mm: [number, number];
  image: AssetRef;
}

export interface PieceDef extends DefBase {
  kind: "piece";
  size_mm: [number, number, number]; // footprint width, depth, height
  image: AssetRef; // top-down art for table-2d
  model?: AssetRef; // glTF for Phase 2
}

/** Path inside the game version, e.g. "assets/fish-1.png". Phase 2 adds "lib:<id>@<version>". */
export type AssetRef = string;
```

Allowed image types in Phase 1: PNG, JPEG, WebP, AVIF. SVG is not allowed (it can carry scripts).

## Zones

```ts
export interface ZoneDef {
  id: string;
  layout: "stack" | "row" | "fan" | "grid" | "free";
  rect_mm: { x: number; y: number; w: number; h: number }; // x, y = zone center
  owner?: SeatId | "each"; // "each" expands to one zone per seat (sandbox), id suffixed ":<seat>"
  visibility: "public" | "owner";
  label?: string;
  grid?: { cols: number; rows: number }; // layout "grid" only
}
```

- `stack`: items piled; index 0 is the bottom; renderers show the top item and a count.
- `row` and `fan`: items side by side in index order (`fan` overlaps them, for hands).
- `grid`: index = `row * cols + col`.
- `free`: items placed by `pos_mm`.

## Table snapshot

Produced by `present` for one viewing seat. Renderers draw only this.

```ts
export interface TableSnapshot {
  table: { size_mm: [number, number] };
  zones: ZonePlacement[];
  items: ItemPlacement[];
  hud?: HudEntry[];
  prompt?: string; // e.g. "Select 2 or more cards of one good to ship"
}

export interface ZonePlacement {
  id: string;
  layout: ZoneDef["layout"];
  rect_mm: { x: number; y: number; w: number; h: number };
  owner?: SeatId;
  label?: string;
  droppable?: boolean; // renderer allows drops here
  grid?: { cols: number; rows: number };
}

export interface ItemPlacement {
  id: string; // opaque instance id
  zone: string;
  index?: number; // stack/row/fan/grid order
  pos_mm?: [number, number]; // free zones only
  rotation_deg?: number;
  face: "up" | "down";
  def?: string; // ComponentDef id — MUST be omitted when this seat may not know the identity
  back?: string; // CardBackDef id, required when def is omitted for a card
  value?: number; // die: face showing, 1..sides
  selectable?: boolean;
  draggable?: boolean;
  highlight?: "legal" | "selected" | "warning";
  badge?: string; // small overlay text, e.g. a count
}

export interface HudEntry {
  seat: SeatId;
  name?: string;
  score?: number;
  handCount?: number;
  active: boolean;
}
```

**Hidden-information invariant:** for every item a seat may not identify, the snapshot has no `def`, and the item's `id` is opaque. A test asserts this for the reference game and for sandbox mode (docs/testing.md).

## Gestures

Emitted by renderers, turned into intents by `interpret` (enforced) or by the platform (sandbox).

```ts
export type Gesture =
  | { kind: "click"; item: string }
  | { kind: "clickZone"; zone: string }
  | {
      kind: "drop";
      item: string;
      from: string;
      to: string;
      index?: number;
      pos_mm?: [number, number];
    };
```

Selection is renderer UI state. The app passes the current selection to `actions`, whose buttons carry intents.

## Renderer interface

Implemented by `@bgp/table-2d` now and `@bgp/table-3d` in Phase 2.

```ts
export interface TableRenderer {
  mount(
    container: HTMLElement,
    init: {
      components: ComponentsFile;
      assetUrl(ref: AssetRef): string;
      seat: SeatId | null;
    },
  ): Promise<void>;
  setSnapshot(snapshot: TableSnapshot): void; // animates changes matched by item id
  onGesture(handler: (g: Gesture) => void): () => void;
  onSelectionChange(handler: (ids: string[]) => void): () => void;
  setSelection(ids: string[]): void;
  resize(): void;
  destroy(): void;
}
```

## Sandbox state and manual operations

Sandbox games run on the built-in definition `createSandboxDefinition(components)` from `@bgp/rules`.

```ts
export interface SandboxSetup {
  instances: {
    def: string;
    zone: string;
    count?: number;
    face?: "up" | "down";
    shuffle?: boolean;
  }[];
}

export interface SandboxState {
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
}

/** Sent as { move: "manual", args: ManualOp }. Any seat may act at any time. */
export type ManualOp =
  | {
      op: "move";
      item: string;
      to: string;
      index?: number;
      pos_mm?: [number, number];
      face?: "up" | "down";
    }
  | { op: "flip"; item: string }
  | { op: "rotate"; item: string; deg: number } // absolute, 0..359
  | { op: "shuffle"; zone: string } // re-keys item ids in the zone
  | { op: "deal"; from: string; to: string[]; count: number; face?: "up" | "down" } // to: zone ids, round-robin
  | { op: "roll"; item: string } // die gets a random value
  | { op: "endTurn" }; // advances ctx.currentSeat for the HUD only
```

**Sandbox visibility.** A seat may identify an item when:

- the item is in an `owner` zone belonging to that seat (any face), or
- the item is face up in a `public` zone.

Otherwise the view omits `def` (cards show their back). Moving an item between zones does not change its face unless `face` is given; dealing defaults to face down into `owner` zones.

**Validation.** Unknown items or zones, a `pos_mm` outside the table, and taking an item out of another seat's `owner` zone are rejected as `INVALID_ARGS`. Giving an item to another seat's `owner` zone is allowed, as at a real table.
