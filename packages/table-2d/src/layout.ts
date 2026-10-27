import type {
  ComponentDef,
  ComponentsFile,
  ItemPlacement,
  TableSnapshot,
  ZonePlacement,
} from "@bgp/schema";

export interface PlacedItem {
  item: ItemPlacement;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  count: number;
}

export function itemSize(item: ItemPlacement, defs: readonly ComponentDef[]): [number, number] {
  const def = defs.find((candidate) => candidate.id === item.def);
  if (!def || def.kind === "cardBack") return [63, 88];
  if (def.kind === "die") return [def.size_mm, def.size_mm];
  return [def.size_mm[0], def.size_mm[1]];
}

export function layoutZone(
  zone: ZonePlacement,
  items: readonly ItemPlacement[],
  components: ComponentsFile,
): PlacedItem[] {
  const ordered = items
    .filter((item) => item.zone === zone.id)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const visible = zone.layout === "stack" ? ordered.slice(-1) : ordered;
  const { x, y, w, h } = zone.rect_mm;
  return visible.map((item, i) => {
    const [width, height] = itemSize(item, components.defs);
    const placement: PlacedItem = {
      item,
      x,
      y,
      width,
      height,
      rotation: item.rotation_deg ?? 0,
      count: zone.layout === "stack" ? ordered.length : 1,
    };
    if (zone.layout === "free") {
      [placement.x, placement.y] = item.pos_mm ?? [x, y];
    } else if (zone.layout === "grid") {
      const cols = zone.grid?.cols ?? Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const rows = zone.grid?.rows ?? Math.max(1, Math.ceil(ordered.length / cols));
      placement.x = x - w / 2 + (((i % cols) + 0.5) * w) / cols;
      placement.y = y + h / 2 - ((Math.floor(i / cols) + 0.5) * h) / rows;
    } else if (zone.layout === "row" || zone.layout === "fan") {
      const step =
        ordered.length < 2
          ? 0
          : Math.min(
              width * (zone.layout === "fan" ? 0.55 : 1.1),
              Math.max(0, w - width) / (ordered.length - 1),
            );
      const offset = i - (ordered.length - 1) / 2;
      placement.x = x + offset * step;
      if (zone.layout === "fan") {
        const angle = ordered.length < 2 ? 0 : offset * Math.min(12, 60 / (ordered.length - 1));
        placement.rotation += angle;
        placement.y = y - Math.abs(offset) * Math.min(5, h / Math.max(1, ordered.length));
      }
    }
    return placement;
  });
}

export function layoutSnapshot(snapshot: TableSnapshot, components: ComponentsFile): PlacedItem[] {
  return snapshot.zones.flatMap((zone) => layoutZone(zone, snapshot.items, components));
}

export interface Viewport {
  width: number;
  height: number;
  scale: number;
  angle: number;
  panX: number;
  panY: number;
}
export function fitViewport(
  snapshot: TableSnapshot,
  width: number,
  height: number,
  seat: string | null,
): Viewport {
  const owners = [
    ...new Set(snapshot.zones.flatMap((zone) => (zone.owner === undefined ? [] : [zone.owner]))),
  ].sort();
  const seatIndex = seat === null ? -1 : owners.indexOf(seat);
  const angle = seatIndex < 0 ? 0 : (-seatIndex * 2 * Math.PI) / owners.length;
  const [w, h] = snapshot.table.size_mm;
  const rotatedW = Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle));
  const rotatedH = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle));
  return {
    width,
    height,
    scale: Math.max(0.01, Math.min((width - 24) / rotatedW, (height - 24) / rotatedH)),
    angle,
    panX: 0,
    panY: 0,
  };
}
export function tableToScreen(x: number, y: number, view: Viewport): [number, number] {
  const c = Math.cos(view.angle),
    s = Math.sin(view.angle);
  return [
    view.width / 2 + view.panX + (x * c + y * s) * view.scale,
    view.height / 2 + view.panY + (x * s - y * c) * view.scale,
  ];
}
export function screenToTable(x: number, y: number, view: Viewport): [number, number] {
  const dx = (x - view.width / 2 - view.panX) / view.scale;
  const dy = (y - view.height / 2 - view.panY) / view.scale;
  return [
    dx * Math.cos(view.angle) + dy * Math.sin(view.angle),
    dx * Math.sin(view.angle) - dy * Math.cos(view.angle),
  ];
}
export function hitZone(snapshot: TableSnapshot, x: number, y: number): ZonePlacement | undefined {
  return [...snapshot.zones]
    .reverse()
    .find(({ rect_mm: r }) => Math.abs(x - r.x) <= r.w / 2 && Math.abs(y - r.y) <= r.h / 2);
}
export function hitItem(
  items: readonly PlacedItem[],
  x: number,
  y: number,
): PlacedItem | undefined {
  return [...items].reverse().find((item) => {
    const angle = (item.rotation * Math.PI) / 180;
    const dx = x - item.x,
      dy = y - item.y;
    return (
      Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle)) <= item.width / 2 &&
      Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle)) <= item.height / 2
    );
  });
}
