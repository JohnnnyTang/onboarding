import { applyIntent, createMatch, viewFor } from "@bgp/rules";
import {
  type ComponentsFile,
  GamePackageSchema,
  type PresentInfo,
  TableSnapshotSchema,
} from "@bgp/schema";
import { describe, expect, test } from "vitest";
import manifest from "../bgp.json" with { type: "json" };
import declarations from "../components.json" with { type: "json" };
import game from "../src/index.js";
import { required } from "../src/model.js";

export const components: ComponentsFile = GamePackageSchema.parse({
  manifest,
  components: declarations,
}).components;
function fresh(count = 4) {
  return createMatch(game, {
    seats: Array.from({ length: count }, (_, i) => String(i)),
    seed: 66,
    options: {},
  });
}
const interpret = required(game.interpret);
const actions = required(game.actions);
const info: PresentInfo = { seat: "0", components };

describe("Harbor Market presentation", () => {
  test("declares the manifest, 15 goods, a shared back and six tide faces", () => {
    expect(GamePackageSchema.parse({ manifest, components }).manifest.players).toEqual({
      min: 2,
      max: 4,
    });
    expect(components.defs.filter((def) => def.kind === "card")).toHaveLength(15);
    expect(components.defs.find((def) => def.id === "tide")).toMatchObject({
      sides: 6,
      size_mm: 16,
      faces: ["Fish", "Salt", "Silk", "Spice", "Tea", "Calm"],
    });
  });
  test.each([2, 3, 4])(
    "lays out %i seats clockwise with private hands and a public HUD",
    (count) => {
      const state = fresh(count);
      for (const seat of [...state.ctx.seats, null]) {
        const view = viewFor(game, state, seat);
        const snapshot = TableSnapshotSchema.parse(game.present(view, { ...info, seat }));
        expect(snapshot.table.size_mm).toEqual([900, 900]);
        expect(snapshot.hud).toHaveLength(count);
        expect(snapshot.items.find((item) => item.id === "deck-top")).toMatchObject({
          face: "down",
          back: "goods-back",
          badge: String(state.game.deck.length),
        });
        expect(snapshot.items.find((item) => item.id === "tide-die")?.value).toBe(
          state.game.tideFace,
        );
        for (const [index, owner] of state.ctx.seats.entries()) {
          const handZone = required(snapshot.zones.find((zone) => zone.id === `hand:${owner}`));
          const edge = count === 2 ? index * 2 : index;
          expect(handZone.rotation_deg).toBe(edge * 90);
          expect([handZone.rect_mm.x, handZone.rect_mm.y]).toEqual(
            [
              [0, -380],
              [-380, 0],
              [0, 380],
              [380, 0],
            ][edge],
          );
          const items = snapshot.items.filter((item) => item.zone === `hand:${owner}`);
          expect(items).toHaveLength(4);
          if (owner === seat)
            for (const item of items)
              expect(item).toMatchObject({
                face: "up",
                selectable: seat === "0",
                draggable: seat === "0",
              });
          else
            for (const [i, item] of items.entries()) {
              expect(item).toMatchObject({
                id: `x:${owner}:${i}`,
                face: "down",
                back: "goods-back",
              });
              expect(item).not.toHaveProperty("def");
            }
        }
        expect(snapshot.prompt).toBe(
          seat === "0" ? "Your turn: swap, ship or restock" : "Waiting for Seat 1",
        );
      }
    },
  );
  test("shows public harbors and only the top discard, hides an empty deck", () => {
    const view = viewFor(game, fresh(), "0");
    const cards = view.game.hand.slice(0, 2);
    view.game.hand = view.game.hand.slice(2);
    view.game.discard = cards;
    view.game.harbors["1"] = view.game.market.splice(0, 1);
    view.game.deckCount = 0;
    const snapshot = game.present(view, info);
    expect(snapshot.items.find((item) => item.zone === "deck")).toBeUndefined();
    expect(snapshot.items.filter((item) => item.zone === "discard")).toEqual([
      {
        id: cards[1]?.id,
        zone: "discard",
        index: 0,
        face: "up",
        def: `${cards[1]?.good}-${cards[1]?.value}`,
        badge: "2",
      },
    ]);
    expect(snapshot.items.filter((item) => item.zone === "harbor:1")).toHaveLength(1);
  });
  test("interprets only a valid own-hand drop at an existing market index", () => {
    const state = fresh();
    const view = viewFor(game, state, "0");
    const item = required(view.game.hand[0]).id;
    const gesture = { kind: "drop", item, from: "hand:0", to: "market", index: 2 } as const;
    const intent = interpret(gesture, view, info);
    expect(intent).toEqual({ move: "swap", args: { hand: item, market: view.game.market[2]?.id } });
    expect(applyIntent(game, state, "0", required(intent ?? undefined)).ok).toBe(true);
    for (const bad of [
      { ...gesture, index: 4 },
      { ...gesture, index: -1 },
      { ...gesture, index: 0.5 },
      { ...gesture, item: "hidden" },
      { ...gesture, from: "hand:1" },
      { ...gesture, to: "deck" },
      { kind: "click", item } as const,
      { kind: "drop", item, from: "hand:0", to: "market" } as const,
    ])
      expect(interpret(bad, view, info)).toBeNull();
    expect(interpret(gesture, view, { ...info, seat: null })).toBeNull();
    view.ctx.phase = "discard";
    expect(interpret(gesture, view, info)).toBeNull();
  });
  test("buttons match legal moves and reject duplicate, foreign and mixed selections", () => {
    const state = fresh();
    const view = viewFor(game, state, "0");
    view.game.hand = [
      { id: "a", good: "fish", value: 1 },
      { id: "b", good: "fish", value: 2 },
      { id: "c", good: "salt", value: 3 },
    ];
    expect(actions(view, info, ["a", "b"])[0]).toMatchObject({
      enabled: true,
      intent: { move: "ship", args: { cards: ["a", "b"] } },
    });
    for (const selection of [[], ["a"], ["a", "a"], ["a", "c"], ["a", "hidden"]])
      expect(actions(view, info, selection)[0]).toMatchObject({ enabled: false });
    expect(actions(view, info, []).find((button) => button.id === "restock")?.enabled).toBe(true);
    expect(actions(view, info, []).find((button) => button.id === "pass")?.enabled).toBe(false);
    view.game.deckCount = 0;
    view.game.market = [];
    view.game.hand = [];
    expect(actions(view, info, []).find((button) => button.id === "pass")).toMatchObject({
      enabled: true,
      intent: { move: "pass" },
    });
  });
  test("discard controls require exactly the excess hand cards", () => {
    const view = viewFor(game, fresh(), "0");
    view.ctx.phase = "discard";
    view.game.hand = Array.from({ length: 8 }, (_, i) => ({
      id: `test-${i}`,
      good: "fish" as const,
      value: 1 as const,
    }));
    expect(actions(view, info, ["test-0", "test-1"])).toEqual([
      {
        id: "discard",
        label: "Discard selected",
        enabled: true,
        intent: { move: "discard", args: { cards: ["test-0", "test-1"] } },
      },
    ]);
    for (const selection of [[], ["test-0"], ["test-0", "test-0"], ["test-0", "hidden"]])
      expect(actions(view, info, selection)[0]?.enabled).toBe(false);
    const snapshot = game.present(view, info);
    expect(snapshot.prompt).toBe("Discard 2 cards");
    for (const item of snapshot.items.filter((item) => item.zone === "hand:0"))
      expect(item).toMatchObject({ selectable: true, draggable: false });
  });
  test("spectators, inactive seats and finished matches have no interactive controls", () => {
    const state = fresh();
    for (const seat of [null, "1"]) {
      const view = viewFor(game, state, seat);
      expect(actions(view, { ...info, seat }, [])).toEqual([]);
      expect(
        game
          .present(view, { ...info, seat })
          .items.some((item) => item.selectable || item.draggable),
      ).toBe(false);
    }
    const view = viewFor(game, state, "0");
    view.result = { winners: ["0"] };
    expect(actions(view, info, [])).toEqual([]);
    expect(game.present(view, info).prompt).toBe("Game over");
    expect(game.present(view, info).hud?.some((entry) => entry.active)).toBe(false);
  });
});
