import type { TableSnapshot } from "@bgp/schema";

/**
 * The table as every seat together knows it: the union of the seats' snapshots. An item
 * any seat may identify shows its identity; an item no seat may identify (a face-down
 * deck) stays hidden. Nothing is built from the full state. The view is read-only.
 */
export function mergeSnapshots(snapshots: readonly TableSnapshot[]): TableSnapshot | null {
  const [first] = snapshots;
  if (!first) return null;
  const zones = new Map<string, TableSnapshot["zones"][number]>();
  const items = new Map<string, TableSnapshot["items"][number]>();
  for (const snapshot of snapshots) {
    for (const zone of snapshot.zones) {
      if (!zones.has(zone.id)) zones.set(zone.id, { ...zone, droppable: false });
    }
    for (const item of snapshot.items) {
      const known = items.get(item.id);
      if (known?.def !== undefined) continue;
      const { selectable: _s, draggable: _d, highlight: _h, ...rest } = item;
      if (!known || rest.def !== undefined) items.set(item.id, rest);
    }
  }
  return {
    table: {
      size_mm: [
        Math.max(...snapshots.map((snapshot) => snapshot.table.size_mm[0])),
        Math.max(...snapshots.map((snapshot) => snapshot.table.size_mm[1])),
      ],
    },
    zones: [...zones.values()],
    items: [...items.values()],
    ...(first.hud ? { hud: first.hud } : {}),
  };
}
