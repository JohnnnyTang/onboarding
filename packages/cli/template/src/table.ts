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
import { type Card, defOf, type View } from "./rules.js";

// Presentation: pure functions of one seat's view. They run in the browser's game worker and
// never see the full state, so they cannot show what the seat may not know.

const BACK = "card-back";

function myTurn(view: ClientView<View>, info: PresentInfo): boolean {
  return view.result === null && info.seat !== null && view.ctx.currentSeat === info.seat;
}

function faceUp(card: Card, zone: string, index: number): ItemPlacement {
  return { id: card.id, zone, index, face: "up", def: defOf(card) };
}

/** One hand per seat around the table; the viewer's own seat sits at the bottom. */
function handZone(seat: string, edge: number): ZonePlacement {
  const centers: [number, number][] = [
    [0, 230],
    [-330, 0],
    [0, -230],
    [330, 0],
  ];
  const [x, y] = centers[edge % centers.length] ?? [0, 230];
  return {
    id: `hand:${seat}`,
    owner: seat,
    layout: "fan",
    rect_mm: { x, y, w: 300, h: 110 },
    rotation_deg: edge * 90,
    label: `Seat ${Number(seat) + 1}`,
  };
}

export function present(view: ClientView<View>, info: PresentInfo): TableSnapshot {
  const mine = myTurn(view, info);
  const zones: ZonePlacement[] = [
    { id: "deck", layout: "stack", rect_mm: { x: -80, y: 0, w: 80, h: 110 }, label: "Deck" },
    {
      id: "pile",
      layout: "stack",
      rect_mm: { x: 80, y: 0, w: 80, h: 110 },
      label: "Pile",
      droppable: mine,
    },
  ];
  const items: ItemPlacement[] = [];
  if (view.game.deckCount > 0) {
    items.push({
      id: "deck-top",
      zone: "deck",
      face: "down",
      back: BACK,
      badge: String(view.game.deckCount),
    });
  }
  items.push(...view.game.pile.map((card, index) => faceUp(card, "pile", index)));
  const seats = view.ctx.seats;
  const start = info.seat === null ? 0 : Math.max(0, seats.indexOf(info.seat));
  for (const [index, seat] of seats.entries()) {
    const edge = (index - start + seats.length) % seats.length;
    zones.push(handZone(seat, seats.length === 2 ? edge * 2 : edge));
    if (seat === info.seat) {
      items.push(
        ...view.game.hand.map((card, i) => ({
          ...faceUp(card, `hand:${seat}`, i),
          draggable: mine,
          selectable: mine,
        })),
      );
    } else {
      // Placeholders with made-up IDs: other hands are only counts in this view.
      const count = view.game.handCounts[seat] ?? 0;
      for (let i = 0; i < count; i += 1) {
        items.push({
          id: `hidden:${seat}:${i}`,
          zone: `hand:${seat}`,
          index: i,
          face: "down",
          back: BACK,
        });
      }
    }
  }
  return {
    table: { size_mm: [900, 700] },
    zones,
    items,
    prompt:
      view.result !== null
        ? "Game over"
        : mine
          ? "Your turn: play a card on the pile"
          : `Waiting for Seat ${Number(view.ctx.currentSeat) + 1}`,
    hud: seats.map((seat) => ({
      seat,
      name: `Seat ${Number(seat) + 1}`,
      score: view.game.scores[seat] ?? 0,
      handCount: view.game.handCounts[seat] ?? 0,
      active: view.result === null && view.ctx.currentSeat === seat,
    })),
  };
}

/** Dragging one of your cards onto the pile plays it. */
export function interpret(
  gesture: Gesture,
  view: ClientView<View>,
  info: PresentInfo,
): MoveIntent | null {
  if (!myTurn(view, info) || gesture.kind !== "drop" || gesture.to !== "pile") return null;
  const card = view.game.hand.find((candidate) => candidate.id === gesture.item);
  return card ? { move: "play", args: { card: card.id } } : null;
}

/** Selecting one of your cards offers a Play button. */
export function actions(
  view: ClientView<View>,
  info: PresentInfo,
  selection: string[],
): ActionButton[] {
  if (!myTurn(view, info)) return [];
  const card = view.game.hand.find(
    (candidate) => selection.length === 1 && candidate.id === selection[0],
  );
  return card
    ? [
        {
          id: "play",
          label: "Play selected",
          enabled: true,
          intent: { move: "play", args: { card: card.id } },
        },
      ]
    : [
        {
          id: "play",
          label: "Play selected",
          enabled: false,
          hint: "Select one card in your hand",
        },
      ];
}
