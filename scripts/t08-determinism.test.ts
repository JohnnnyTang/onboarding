import type { GameDefinition } from "@bgp/schema";
import { expect, it } from "vitest";
import { applyIntent, createMatch, hashState } from "../packages/rules/src/index.js";
import { QuickJsSandbox } from "../packages/rules-host/src/quickjs-sandbox.js";
import { GAME_SOURCE, INIT } from "../packages/rules-host/test/fixtures.js";

it("matches Node and QuickJS hashes after every seeded fixture move", async () => {
  // This fixed repository fixture is trusted; uploaded modules are never imported in Node.
  const fixture = (await import(`data:text/javascript,${encodeURIComponent(GAME_SOURCE)}`)) as {
    default: GameDefinition<{ count: number; secret: string }>;
  };
  for (const seed of [0, 1, 123, 0xffffffff]) {
    const sandbox = await QuickJsSandbox.load(GAME_SOURCE);
    try {
      const init = { ...INIT, seed };
      await sandbox.create(init);
      let direct = createMatch(fixture.default, init);
      expect(await sandbox.hash()).toBe(await hashState(direct));
      for (let step = 0; step < 25; step++) {
        const intent = { move: step % 5 === 0 ? "reject" : "tick" };
        const result = applyIntent(fixture.default, direct, "0", intent);
        expect(await sandbox.apply("0", intent)).toMatchObject({ ok: result.ok });
        if (result.ok) direct = result.state;
        expect(await sandbox.hash()).toBe(await hashState(direct));
      }
    } finally {
      sandbox.dispose();
    }
  }
});
