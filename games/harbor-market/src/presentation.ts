import type {
  ActionButton,
  ClientView,
  Gesture,
  ItemPlacement,
  MoveIntent,
  PresentInfo,
  TableSnapshot,
  ZonePlacement,
} from "@bgp/schema";
import { type Card, GOODS, type HarborView, required } from "./model.js";

function canAct(view: ClientView<HarborView>, info: PresentInfo): boolean {
  return (
    view.result === null &&
    info.seat !== null &&
    info.seat === view.ctx.currentSeat &&
    view.ctx.activeSeats.includes(info.seat)
  );
}
function faceUp(card: Card, zone: string, index: number): ItemPlacement {
  return { id: card.id, zone, index, face: "up", def: `${card.good}-${card.value}` };
}
function seatZone(seat: string, edge: number, harbor: boolean): ZonePlacement {
  const distance = harbor ? 250 : 380;
  const centers: [number, number][] = [
    [0, -distance],
    [-distance, 0],
    [0, distance],
    [distance, 0],
  ];
  const [x, y] = required(centers[edge]);
  return {
    id: `${harbor ? "harbor" : "hand"}:${seat}`,
    owner: seat,
    layout: harbor ? "row" : "fan",
    rect_mm: { x, y, w: harbor ? 600 : 500, h: 110 },
    rotation_deg: edge * 90,
    label: `Seat ${Number(seat) + 1} ${harbor ? "harbor" : "hand"}`,
  };
}
function prompt(view: ClientView<HarborView>, info: PresentInfo): string {
  if (view.result !== null) return "Game over";
  if (!canAct(view, info)) return `Waiting for Seat ${Number(view.ctx.currentSeat) + 1}`;
  if (view.ctx.phase === "discard") return `Discard ${view.game.hand.length - 6} cards`;
  return "Your turn: swap, ship or restock";
}
export function present(view: ClientView<HarborView>, info: PresentInfo): TableSnapshot {
  const active = canAct(view, info);
  const main = active && view.ctx.phase === "main";
  const zones: ZonePlacement[] = [
    { id: "deck", layout: "stack", rect_mm: { x: -230, y: 0, w: 80, h: 110 }, label: "Deck" },
    { id: "tide", layout: "stack", rect_mm: { x: -230, y: 120, w: 40, h: 40 }, label: "Tide" },
    {
      id: "market",
      layout: "row",
      rect_mm: { x: 20, y: 0, w: 300, h: 110 },
      label: "Market",
      droppable: main && view.game.market.length > 0,
    },
    { id: "discard", layout: "stack", rect_mm: { x: 260, y: 0, w: 80, h: 110 }, label: "Discard" },
  ];
  const items: ItemPlacement[] = view.game.market.map((card, index) =>
    faceUp(card, "market", index),
  );
  if (view.game.deckCount > 0)
    items.push({
      id: "deck-top",
      zone: "deck",
      face: "down",
      back: "goods-back",
      badge: String(view.game.deckCount),
    });
  const discard = view.game.discard[view.game.discard.length - 1];
  if (discard)
    items.push({ ...faceUp(discard, "discard", 0), badge: String(view.game.discard.length) });
  if (view.game.tideFace !== null)
    items.push({
      id: "tide-die",
      zone: "tide",
      face: "up",
      def: "tide",
      value: view.game.tideFace,
    });
  for (const [index, seat] of view.ctx.seats.entries()) {
    const edge = view.ctx.seats.length === 2 ? index * 2 : index;
    zones.push(seatZone(seat, edge, false), seatZone(seat, edge, true));
    if (seat === info.seat) {
      items.push(
        ...view.game.hand.map((card, i) => ({
          ...faceUp(card, `hand:${seat}`, i),
          selectable: active,
          draggable: main,
        })),
      );
    } else {
      for (let i = 0; i < required(view.game.handCounts[seat]); i += 1)
        items.push({
          id: `x:${seat}:${i}`,
          zone: `hand:${seat}`,
          index: i,
          face: "down",
          back: "goods-back",
        });
    }
    items.push(
      ...required(view.game.harbors[seat]).map((card, i) => faceUp(card, `harbor:${seat}`, i)),
    );
  }
  return {
    table: { size_mm: [900, 900] },
    zones,
    items,
    prompt: prompt(view, info),
    hud: view.ctx.seats.map((seat) => ({
      seat,
      name: `Seat ${Number(seat) + 1}`,
      score: required(view.game.scores[seat]),
      handCount: required(view.game.handCounts[seat]),
      active: view.result === null && view.ctx.activeSeats.includes(seat),
    })),
  };
}
export function interpret(
  gesture: Gesture,
  view: ClientView<HarborView>,
  info: PresentInfo,
): MoveIntent | null {
  if (
    !canAct(view, info) ||
    view.ctx.phase !== "main" ||
    gesture.kind !== "drop" ||
    gesture.from !== `hand:${info.seat}` ||
    gesture.to !== "market" ||
    gesture.index === undefined ||
    !Number.isSafeInteger(gesture.index) ||
    !view.game.hand.some((card) => card.id === gesture.item)
  )
    return null;
  const market = view.game.market[gesture.index];
  return market ? { move: "swap", args: { hand: gesture.item, market: market.id } } : null;
}
function button(id: string, label: string, enabled: boolean, intent: MoveIntent): ActionButton {
  return enabled ? { id, label, enabled, intent } : { id, label, enabled };
}
export function actions(
  view: ClientView<HarborView>,
  info: PresentInfo,
  selection: string[],
): ActionButton[] {
  if (!canAct(view, info)) return [];
  const cards = view.game.hand.filter((card) => selection.includes(card.id));
  const valid = cards.length === selection.length;
  if (view.ctx.phase === "discard")
    return [
      button(
        "discard",
        "Discard selected",
        valid && selection.length === view.game.hand.length - 6,
        { move: "discard", args: { cards: [...selection] } },
      ),
    ];
  if (view.ctx.phase !== "main") return [];
  const canShip = GOODS.some(
    (good) => view.game.hand.filter((card) => card.good === good).length >= 2,
  );
  const canSwap = view.game.hand.length > 0 && view.game.market.length > 0;
  return [
    button(
      "ship",
      "Ship selected",
      valid && cards.length >= 2 && cards.every((card) => card.good === cards[0]?.good),
      { move: "ship", args: { cards: [...selection] } },
    ),
    button("restock", "Restock", view.game.deckCount > 0, { move: "restock" }),
    button("pass", "Pass", !canShip && !canSwap && view.game.deckCount === 0, { move: "pass" }),
  ];
}
