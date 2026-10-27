import { expect, it } from "vitest";
import { VmProcessSandbox } from "../spike/vm-process.js";
import { HOSTILE_CASES, hostile, INIT } from "./fixtures.js";

it.each(HOSTILE_CASES)("VM process comparison: %s is contained", async (_name, body) => {
  const healthy = await VmProcessSandbox.load(hostile("state.count += 1;"));
  const bad = await VmProcessSandbox.load(hostile(body));
  try {
    await healthy.create(INIT);
    await bad.create(INIT);
    const started = performance.now();
    const result = await bad
      .apply("0", { move: "tick" })
      .catch(() => ({ ok: false, code: "GAME_ERROR" }));
    expect(result).toMatchObject({ ok: false, code: "GAME_ERROR" });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(await healthy.apply("0", { move: "tick" })).toMatchObject({ ok: true });
  } finally {
    healthy.dispose();
    bad.dispose();
  }
});
