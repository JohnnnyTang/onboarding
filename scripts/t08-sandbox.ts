import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import type { GameDefinition } from "@bgp/schema";
import { applyIntent, createMatch, hashState } from "../packages/rules/src/index.js";
import { VmProcessSandbox } from "../packages/rules-host/spike/vm-process.js";
import type { RulesSandbox } from "../packages/rules-host/src/index.js";
import { QuickJsSandbox } from "../packages/rules-host/src/index.js";
import { GAME_SOURCE, HOSTILE_CASES, hostile, INIT } from "../packages/rules-host/test/fixtures.js";

function p95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
}

async function benchmark(load: (source: string) => Promise<RulesSandbox>) {
  const loads: number[] = [];
  const moves: number[] = [];
  const rssBefore = process.memoryUsage().rss;
  let coldMs = 0;
  const idle: RulesSandbox[] = [];
  let heap: unknown;
  let childHeap: number | undefined;
  let childRss: number | undefined;
  try {
    for (let i = 0; i < 21; i++) {
      const started = performance.now();
      const match = await load(GAME_SOURCE);
      idle.push(match);
      await match.create(INIT);
      const elapsed = performance.now() - started;
      if (i === 0) coldMs = elapsed;
      else loads.push(elapsed);
      if (match instanceof QuickJsSandbox) heap = match.memoryUsage();
      if (match instanceof VmProcessSandbox) {
        childHeap = match.heapBytes;
        childRss = match.rssBytes;
      }
    }
    const rssDeltaPerMatch = (process.memoryUsage().rss - rssBefore) / idle.length;
    const match = idle[0];
    if (!match) throw Error("Missing fixture");
    const module = (await import(`data:text/javascript,${encodeURIComponent(GAME_SOURCE)}`)) as {
      default: GameDefinition<{ count: number; secret: string }>;
    };
    let direct = createMatch(module.default, INIT);
    for (let i = 0; i < 500; i++) {
      const started = performance.now();
      const outcome = await match.apply("0", { move: "tick" });
      moves.push(performance.now() - started);
      const result = applyIntent(module.default, direct, "0", { move: "tick" });
      if (!outcome.ok || !result.ok) throw Error("Fixture rejected");
      direct = result.state;
      if ((await hashState(direct)) !== (await match.hash()))
        throw Error("Cross-engine hash mismatch");
    }
    return {
      coldLoadAndCreateMs: coldMs,
      warmLoadAndCreateP95Ms: p95(loads),
      moveP95Ms: p95(moves),
      parentRssDeltaPerMatchBytes: rssDeltaPerMatch,
      quickjsHeap: heap,
      vmChildHeapBytes: childHeap,
      vmChildRssBytes: childRss,
      deterministicSteps: 500,
      warmLoadSamples: loads.length,
    };
  } finally {
    for (const match of idle) match.dispose();
  }
}

async function isolation(load: (source: string) => Promise<RulesSandbox>) {
  const outcomes = [];
  const healthy = await load(GAME_SOURCE);
  try {
    await healthy.create(INIT);
    for (const [name, body] of HOSTILE_CASES) {
      let match: RulesSandbox | undefined;
      let code = "LOAD_ERROR";
      let elapsedMs = 0;
      try {
        match = await load(hostile(body));
        await match.create(INIT);
        const started = performance.now();
        try {
          const outcome = await match.apply("0", { move: "tick" });
          code = outcome.ok ? "UNCONTAINED" : outcome.code;
        } catch {
          code = "GAME_ERROR";
        }
        elapsedMs = performance.now() - started;
      } finally {
        match?.dispose();
      }
      const healthyResult = await healthy.apply("0", { move: "tick" });
      if (code !== "GAME_ERROR" || elapsedMs >= 1500 || !healthyResult.ok)
        throw Error(`Isolation failed: ${name}`);
      outcomes.push({ name, code, elapsedMs, healthyMatchContinued: healthyResult.ok });
    }
  } finally {
    healthy.dispose();
  }
  return outcomes;
}

const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model,
  fixture:
    "Two-seat hidden-counter fixture; Harbor Market is not implemented at this base revision",
  quickjs: {
    ...(await benchmark((source) => QuickJsSandbox.load(source))),
    isolation: await isolation((source) => QuickJsSandbox.load(source)),
  },
  vmProcess: {
    ...(await benchmark((source) => VmProcessSandbox.load(source))),
    isolation: await isolation((source) => VmProcessSandbox.load(source)),
  },
};
await writeFile("docs/spikes/t08-sandbox-results.json", `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
