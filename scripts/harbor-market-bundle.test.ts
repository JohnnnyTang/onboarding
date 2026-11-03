import { build } from "esbuild";
import { expect, test } from "vitest";
import game from "../games/harbor-market/src/index.js";
import { required } from "../games/harbor-market/src/model.js";
import { applyIntent, createMatch, hashState, viewFor } from "../packages/rules/src/index.js";
import { QuickJsSandbox } from "../packages/rules-host/src/quickjs-sandbox.js";

test("Harbor Market bundles without imports and replays identically in QuickJS", async () => {
  const built = await build({
    entryPoints: ["games/harbor-market/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    metafile: true,
  });
  const source = built.outputFiles[0]?.text;
  if (!source) throw new Error("Game bundle missing");
  expect(Buffer.byteLength(source)).toBeLessThanOrEqual(2 * 1024 * 1024);
  for (const output of Object.values(built.metafile.outputs)) expect(output.imports).toEqual([]);
  const host = await QuickJsSandbox.load(source);
  try {
    const init = { seats: ["0", "1", "2", "3"], seed: 606, options: { shortGame: true } };
    let state = createMatch(game, init);
    await host.create(init);
    let steps = 0;
    while (true) {
      expect(await host.hash()).toBe(await hashState(state));
      expect(await host.views()).toEqual(
        Object.fromEntries(init.seats.map((seat) => [seat, viewFor(game, state, seat)])),
      );
      if (state.result !== null) break;
      if (++steps > 100) throw new Error("Fixture did not finish");
      const choices = required(game.legalMoves)(state.game, state.ctx, state.ctx.currentSeat);
      const intent = required(choices.find((intent) => intent.move === "restock") ?? choices[0]);
      const outcome = await host.apply(state.ctx.currentSeat, intent);
      const direct = applyIntent(game, state, state.ctx.currentSeat, intent);
      expect(outcome.ok).toBe(true);
      if (!direct.ok) throw new Error("Direct move rejected");
      state = direct.state;
    }
    expect(steps).toBeGreaterThan(0);
  } finally {
    host.dispose();
  }
});
