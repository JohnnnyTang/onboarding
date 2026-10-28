import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import type { GameDefinition, Json } from "@bgp/schema";
import { applyIntent, createMatch, hashState } from "../packages/rules/src/index.js";
import { GameError, RulesHostClient } from "../packages/rules-host/src/index.js";
import { QuickJsSandbox } from "../packages/rules-host/src/quickjs-sandbox.js";
import { GAME_SOURCE, HOSTILE_CASES, hostile, INIT } from "../packages/rules-host/test/fixtures.js";

import { childRss, p95 } from "./t08-measurements.js";

function fixture(source: string) {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const buildHash = createHash("sha256").update(`game.js\t${sourceHash}\n`).digest("hex");
  return {
    buildHash,
    build: { entry: "game.js", files: { "game.js": sourceHash }, source },
  };
}

async function benchmark() {
  const { buildHash, build } = fixture(GAME_SOURCE);
  const client = new RulesHostClient({ load: async () => build });
  const interpreter = await QuickJsSandbox.load(GAME_SOURCE);
  const loads: number[] = [];
  const moves: number[] = [];
  const pids: number[] = [];
  try {
    await interpreter.create(INIT);
    await client.load(buildHash);
    for (let index = 0; index < 21; index++) {
      const start = performance.now();
      await client.create(`idle-${index}`, { ...INIT, buildHash });
      loads.push(performance.now() - start);
      const pid = client.processId(`idle-${index}`);
      if (!pid) throw Error("Missing child process");
      pids.push(pid);
    }
    const rss = await childRss(pids);
    const module = (await import(`data:text/javascript,${encodeURIComponent(GAME_SOURCE)}`)) as {
      default: GameDefinition<Json>;
    };
    let direct = createMatch(module.default, INIT);
    for (let index = 0; index < 500; index++) {
      const start = performance.now();
      const outcome = await client.apply("idle-0", "0", { move: "tick" });
      moves.push(performance.now() - start);
      const expected = applyIntent(module.default, direct, "0", { move: "tick" });
      if (!expected.ok || !outcome.ok) throw Error("Fixture rejected");
      direct = expected.state;
      if ((await client.hash("idle-0")) !== (await hashState(direct)))
        throw Error("Cross-engine divergence");
      if ((index + 1) % 50 === 0) await client.exportState("idle-0");
    }
    const checkpoint = await client.exportState("idle-0");
    const expectedHash = await client.hash("idle-0");
    // Crash containment/restart is also checked by the integration suite while busy.
    const pid = client.processId("idle-0");
    if (!pid) throw Error("Missing child");
    process.kill(pid, "SIGKILL");
    const start = performance.now();
    // The first read may race the exit notification; uncertain calls fail cleanly.
    try {
      await client.hash("idle-0");
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
    }
    await client.restore("idle-0", checkpoint, []);
    if ((await client.hash("idle-0")) !== expectedHash) throw Error("Recovery divergence");
    return {
      samples: { idleMatches: 21, warmLoads: 20, moves: moves.length },
      firstCreateMs: loads[0],
      warmCreateP95Ms: p95(loads.slice(1)),
      moveP95Ms: p95(moves),
      childRssBytes: rss,
      childRssMeanBytes: rss.reduce((sum, value) => sum + value, 0) / rss.length,
      interpreterHeap: interpreter.memoryUsage(),
      deterministicSteps: moves.length,
      recoveryMs: performance.now() - start,
      recoveryHashMatched: true,
      idle: await idleMeasurements(
        client,
        Array.from({ length: 21 }, (_, index) => `idle-${index}`),
      ),
    };
  } finally {
    client.close();
    interpreter.dispose();
  }
}

async function idleMeasurements(client: RulesHostClient, matches: string[]) {
  const before = new Map<string, string>();
  for (const matchId of matches) before.set(matchId, await client.hash(matchId));
  const deadline = performance.now() + 15_000;
  while (matches.some((matchId) => client.processId(matchId) !== undefined)) {
    if (performance.now() >= deadline) throw Error("Idle processes were not retired");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sparePids = client.spareProcessIds();
  const rss = sparePids.length === 0 ? [] : await childRss(sparePids);
  const parent = process.memoryUsage();
  const resumes: number[] = [];
  for (const matchId of matches) {
    const start = performance.now();
    if ((await client.hash(matchId)) !== before.get(matchId))
      throw Error("Idle checkpoint diverged");
    resumes.push(performance.now() - start);
  }
  return {
    idleMatches: matches.length,
    assignedProcesses: 0,
    warmSpareProcesses: sparePids.length,
    warmSpareRssBytes: rss,
    hostChildRssTotalBytes: rss.reduce((sum, value) => sum + value, 0),
    hostChildRssPerIdleMatchBytes: rss.reduce((sum, value) => sum + value, 0) / matches.length,
    parentRssBytes: parent.rss,
    parentHeapUsedBytes: parent.heapUsed,
    totalObservedRssPerIdleMatchBytes:
      (parent.rss + rss.reduce((sum, value) => sum + value, 0)) / matches.length,
    resumeP95Ms: p95(resumes),
    resumeFirstMs: resumes[0],
    restoredHashes: resumes.length,
    note: "Per-idle-match value amortizes the one shared spare across 21 matches; parent absolute memory is separate and includes the measurement runner. Active process RSS is reported above.",
  };
}

async function isolation() {
  const healthy = fixture(GAME_SOURCE);
  const builds = new Map([[healthy.buildHash, healthy.build]]);
  const client = new RulesHostClient({
    load: async (hash) => {
      const build = builds.get(hash);
      if (!build) throw Error("Missing fixture build");
      return build;
    },
  });
  const outcomes = [];
  try {
    await client.load(healthy.buildHash);
    await client.create("healthy", { ...INIT, buildHash: healthy.buildHash });
    for (const [name, body] of HOSTILE_CASES) {
      const bad = fixture(hostile(body));
      builds.set(bad.buildHash, bad.build);
      await client.load(bad.buildHash);
      await client.create("bad", { ...INIT, buildHash: bad.buildHash });
      const start = performance.now();
      const hostileCall = client.apply("bad", "0", { move: "tick" }).catch((error: unknown) => {
        if (!(error instanceof GameError)) throw error;
        return { ok: false, code: error.code };
      });
      const healthyStart = performance.now();
      if (!(await client.apply("healthy", "0", { move: "tick" })).ok)
        throw Error("Healthy match failed");
      const healthyMoveMs = performance.now() - healthyStart;
      const result = await hostileCall;
      const elapsedMs = performance.now() - start;
      if (result.ok || result.code !== "GAME_ERROR" || elapsedMs >= 1500)
        throw Error(`Isolation failed: ${name}`);
      outcomes.push({ name, code: result.code, elapsedMs, healthyMoveMs });
      client.dispose("bad");
    }
    return outcomes;
  } finally {
    client.close();
  }
}

const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model,
  workload: "Hidden-counter fixture, not Harbor Market (T06 remains a scaffold)",
  production: await benchmark(),
  isolation: await isolation(),
};
await writeFile("docs/spikes/t08-host-results.json", `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
