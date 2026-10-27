export const INIT = { seats: ["0", "1"], seed: 123, options: {} };

// A small hidden-information game, deliberately not a Harbor Market substitute.
export const GAME_SOURCE = `
export default {
  sdk: 1,
  setup({ random }) { return { count: 0, secret: random.id() }; },
  moves: {
    tick: { anySeat: true, apply(state, ctx) { state.count += ctx.random.die(6); } },
    reject: { anySeat: true, apply() { return { invalid: true, code: "NO", message: "Try tick" }; } },
  },
  playerView(state) { return { count: state.count }; },
  present() { return { items: [], zones: [] }; }
};
`;

export function hostile(body: string, hook: "move" | "setup" | "view" = "move"): string {
  if (hook === "setup")
    return GAME_SOURCE.replace("return { count: 0, secret: random.id() };", body);
  if (hook === "view") return GAME_SOURCE.replace("return { count: state.count };", body);
  return GAME_SOURCE.replace("state.count += ctx.random.die(6);", body);
}

export const HOSTILE_CASES = [
  ["infinite loop", "while (true) {}"],
  ["allocation", "const a = []; while (true) a.push(new Array(10000).fill('secret'));"],
  ["fetch", "fetch('https://example.com');"],
  ["process", "process.exit(1);"],
  ["require", "require('node:fs');"],
  ["global constructor", "globalThis.constructor.constructor('return process')();"],
  ["dynamic import", "import('node:fs');"],
  ["date", "Date.now();"],
  ["random", "Math.random();"],
] as const;
