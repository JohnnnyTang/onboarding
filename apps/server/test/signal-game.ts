import type { ComponentsFile } from "@bgp/schema";
import type { Package } from "./api-fixture.js";

/**
 * A tiny enforced game for room tests. Every seat holds a secret that only it may see;
 * each accepted `step` replaces the mover's secret. It can produce every rules rejection
 * code on demand: a bad `step` argument, `step` 3 (game rule), `back` outside its phase,
 * `spin` (an infinite loop the sandbox stops) and `finish` (ends the game).
 */
export const SIGNAL_SOURCE = `
export default {
  sdk: 1,
  setup({ seats, random }) {
    const secrets = {};
    for (const seat of seats) secrets[seat] = "secret-" + random.id();
    return { count: 0, secrets };
  },
  startPhase: "main",
  phases: { main: { moves: ["step", "spin", "finish"] }, other: { moves: ["back"] } },
  moves: {
    step: {
      parse(args) {
        if (typeof args !== "object" || args === null || !Number.isInteger(args.n) || args.n < 1 || args.n > 3)
          return { invalid: true, code: "BAD_STEP", message: "n must be 1 to 3" };
        return { n: args.n };
      },
      apply(state, ctx, args) {
        if (args.n === 3) return { invalid: true, code: "TOO_FAR", message: "Three is too far" };
        state.count += args.n;
        state.secrets[ctx.seat] = "secret-" + ctx.random.id();
        ctx.events.endTurn();
      },
    },
    spin: { apply() { while (true) {} } },
    finish: {
      apply(state, ctx) { ctx.events.endGame({ winners: [ctx.seat], reason: "finished" }); },
    },
    back: { apply() {} },
  },
  playerView(state, ctx, seat) {
    return { count: state.count, mine: seat === null ? null : state.secrets[seat] };
  },
  present() { return { items: [], zones: [] }; },
};
`;

export function signalPackage(slug: string): Package {
  const components: ComponentsFile = { schemaVersion: 1, defs: [] };
  return {
    manifest: {
      schemaVersion: 1,
      id: slug,
      name: "Signal",
      version: "0.1.0",
      mode: "enforced",
      sdk: 1,
      players: { min: 2, max: 3 },
      entry: "game.js",
      components: "components.json",
    },
    files: {
      "game.js": Buffer.from(SIGNAL_SOURCE),
      "components.json": Buffer.from(JSON.stringify(components)),
    },
  };
}
