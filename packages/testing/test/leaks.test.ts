import { applyIntent, canonicalJson, createMatch, viewFor } from "@bgp/rules";
import { type GameDefinition, type Json, JsonSchema } from "@bgp/schema";
import { expect, test } from "vitest";
import { checkLeaks, type LeakOracle } from "../src/index.js";
import { components, sampleSandbox } from "./fixtures.js";
import { sandboxOracle } from "./leak-oracles.js";

const init = { seats: ["0", "1", "2"], seed: 42, options: {} };
const options = { components, oracle: sandboxOracle };

test("checks legitimate sandbox views for every seat, including private hands and face-down cards", () => {
  checkLeaks(sampleSandbox, createMatch(sampleSandbox, init), options);
});

test("catches a deliberately leaky game and secrets embedded in nested strings and keys", () => {
  const secret = "private-card-marker";
  const base: GameDefinition<{ secret: string }, Json> = {
    sdk: 1,
    setup: () => ({ secret }),
    moves: {},
    playerView: () => ({}),
    present: () => ({ table: { size_mm: [300, 300] }, items: [], zones: [] }),
  };
  const oracle: LeakOracle<{ secret: string }> = (state) => ({
    forbiddenStrings: [state.game.secret],
    canIdentify: () => false,
    isOpaqueId: () => false,
    isCard: () => false,
  });
  for (const leaked of [
    { secret },
    { nested: [{ text: `card:${secret}!` }] },
    { [secret]: "value" },
  ]) {
    const def = {
      ...base,
      playerView: (_state: { secret: string }, _ctx: unknown, seat: string | null) =>
        seat === "2" ? leaked : {},
    };
    expect(() => checkLeaks(def, createMatch(def, init), { components, oracle })).toThrow(
      "seat 2, ClientView",
    );
  }
  const def = {
    ...base,
    present() {
      return {
        table: { size_mm: [300, 300] as [number, number] },
        items: [],
        zones: [],
        prompt: secret,
      };
    },
  };
  expect(() => checkLeaks(def, createMatch(def, init), { components, oracle })).toThrow(
    "TableSnapshot",
  );
});

test("catches hidden defs in ClientView even when present strips them", () => {
  const def = {
    ...sampleSandbox,
    playerView: (state: Parameters<typeof sampleSandbox.playerView>[0]) => ({ items: state.items }),
  };
  expect(() => checkLeaks(def, createMatch(def, init), options)).toThrow("ClientView");
});

test("catches hidden defs, values, missing backs, identity IDs and unknown components in snapshots", () => {
  const state = createMatch(sampleSandbox, init);
  for (const change of ["def", "value", "back", "id", "unknown-def", "float"] as const) {
    const def: typeof sampleSandbox = {
      ...sampleSandbox,
      present(view, info) {
        const snapshot = sampleSandbox.present(view, info);
        const item = snapshot.items.find((item) => item.zone === "deck");
        if (!item) throw new Error("Missing hidden fixture item");
        if (change === "def") item.def = "secret-fish";
        if (change === "value") item.value = 6;
        if (change === "back") delete item.back;
        if (change === "id") item.id = "i00000000000000000000000000000000";
        if (change === "unknown-def") {
          item.face = "up";
          item.def = "missing";
        }
        if (change === "float") item.rotation_deg = 0.5;
        return snapshot;
      },
    };
    expect(() => checkLeaks(def, state, options), change).toThrow("TableSnapshot");
  }
});

test("retired opaque IDs from a shuffle cannot be leaked anywhere in either output", () => {
  const before = createMatch(sampleSandbox, init);
  const retired = before.game.items.filter((item) => item.zone === "deck").map((item) => item.id);
  const shuffled = applyIntent(sampleSandbox, before, "0", {
    move: "manual",
    args: { op: "shuffle", zone: "deck" },
  });
  if (!shuffled.ok) throw new Error(shuffled.code);
  const oracle: typeof sandboxOracle = (state, seat) => ({
    ...sandboxOracle(state, seat),
    forbiddenStrings: retired,
  });
  checkLeaks(sampleSandbox, shuffled.state, { components, oracle });
  const def: GameDefinition<typeof before.game, Json> = {
    ...sampleSandbox,
    playerView(state, ctx, seat) {
      return { ...sampleSandbox.playerView(state, ctx, seat), stale: retired };
    },
    present: () => ({ table: { size_mm: [300, 300] }, items: [], zones: [] }),
  };
  expect(() => checkLeaks(def, shuffled.state, { components, oracle })).toThrow("ClientView");
});

test("oracle and presenter mutation cannot change runtime state or declarations; failures omit secrets", () => {
  const state = createMatch(sampleSandbox, init);
  const before = canonicalJson(state);
  const declarations = canonicalJson(components);
  const oracle: typeof sandboxOracle = (detached, seat) => {
    const knowledge = sandboxOracle(detached, seat);
    detached.ctx.options = { mutated: true };
    return knowledge;
  };
  const def: typeof sampleSandbox = {
    ...sampleSandbox,
    present(view, info) {
      info.components.defs.length = 0;
      view.ctx.options = { mutated: true };
      return sampleSandbox.present(view, info);
    },
  };
  checkLeaks(def, state, { components, oracle });
  expect(canonicalJson(state)).toBe(before);
  expect(canonicalJson(components)).toBe(declarations);
  expect(() =>
    checkLeaks(
      {
        ...def,
        present() {
          throw new Error("secret-fish");
        },
      },
      state,
      options,
    ),
  ).toThrow(/^Leak check failed at seq 0, seat 0, TableSnapshot$/);
  const view = viewFor(sampleSandbox, state, "0");
  expect(JsonSchema.safeParse(view).success).toBe(true);
});
