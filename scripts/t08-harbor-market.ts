// T08 closure: the D-008 criteria measured on the Harbor Market workload (gates 1 and 2).
// Run with `pnpm build` done first, and separately from other tests (wall-clock timings).
import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { AcceptedEvent, MatchInit, SeatId } from "@bgp/schema";
import { build } from "esbuild";
import game from "../games/harbor-market/src/index.js";
import { type createMatch, viewFor } from "../packages/rules/src/index.js";
import { VmProcessSandbox } from "../packages/rules-host/spike/vm-process.js";
import { RulesHostClient, type RulesSandbox } from "../packages/rules-host/src/index.js";
import { QuickJsSandbox } from "../packages/rules-host/src/quickjs-sandbox.js";
import { runMatch } from "../packages/testing/src/index.js";
import { childRss, hostBuild, idleMeasurements, p95 } from "./t08-measurements.js";

const GAMES = 21;
const SETTLE_MS = 2000;

interface Recorded {
  init: MatchInit;
  events: AcceptedEvent[];
  /** Setup hash at index 0, then one per accepted event. */
  hashes: string[];
  views: { setup: Record<SeatId, unknown>; end: Record<SeatId, unknown> };
}

async function bundle(): Promise<string> {
  // Same options as the harbor-market package build that produces dist/game.js.
  const built = await build({
    entryPoints: ["games/harbor-market/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const source = built.outputFiles[0]?.text;
  if (!source) throw Error("Harbor Market bundle missing");
  return source;
}

function views(state: ReturnType<typeof createMatch>): Record<SeatId, unknown> {
  return Object.fromEntries(state.ctx.seats.map((seat) => [seat, viewFor(game, state, seat)]));
}

/** Legal move sequences from the seeded bot: 2, 3 and 4 seats, short and full games. */
async function record(): Promise<Recorded[]> {
  const games: Recorded[] = [];
  for (let index = 0; index < GAMES; index++) {
    const init: MatchInit = {
      seats: Array.from({ length: 2 + (index % 3) }, (_, seat) => String(seat)),
      seed: 6060 + index,
      options: { shortGame: index % 2 === 0 },
    };
    const run = await runMatch(game, init, { botSeed: 7070 + index, maxMoves: 2000 });
    if (run.stop !== "finished") throw Error(`Game ${index} stopped: ${run.stop}`);
    const first = run.steps[0];
    const last = run.steps.at(-1);
    if (!first || !last) throw Error("Empty run");
    games.push({
      init,
      events: run.events,
      hashes: run.steps.map((step) => step.hash),
      views: { setup: views(first.state), end: views(last.state) },
    });
  }
  return games;
}

// Host replies are schema-validated, so key order differs from direct views; compare content.
function same(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw Error(`${what} diverged`);
}

/** Gate 1: both spike sandboxes replay every game with identical hashes and views. */
async function spike(
  source: string,
  games: Recorded[],
  load: (s: string) => Promise<RulesSandbox>,
) {
  const loads: number[] = [];
  const moves: number[] = [];
  const rssBefore = process.memoryUsage().rss;
  const live: RulesSandbox[] = [];
  let quickjsHeapAtEnd: number[] = [];
  const vmChildRss: number[] = [];
  try {
    for (const [index, recorded] of games.entries()) {
      const started = performance.now();
      const match = await load(source);
      live.push(match);
      await match.create(recorded.init);
      loads.push(performance.now() - started);
      if ((await match.hash()) !== recorded.hashes[0]) throw Error(`Setup hash ${index}`);
      same(await match.views(), recorded.views.setup, `Setup views ${index}`);
      for (const [step, event] of recorded.events.entries()) {
        const moveStart = performance.now();
        const outcome = await match.apply(event.seat, event.intent);
        moves.push(performance.now() - moveStart);
        if (!outcome.ok) throw Error(`Game ${index} move ${step + 1} rejected: ${outcome.code}`);
        if ((await match.hash()) !== recorded.hashes[step + 1])
          throw Error(`Game ${index} hash diverged at seq ${step + 1}`);
      }
      same(await match.views(), recorded.views.end, `Final views ${index}`);
      if (match instanceof VmProcessSandbox) vmChildRss.push(match.rssBytes);
    }
    quickjsHeapAtEnd = live.flatMap((match) => {
      if (!(match instanceof QuickJsSandbox)) return [];
      const usage = match.memoryUsage() as { memory_used_size?: unknown };
      return typeof usage.memory_used_size === "number" ? [usage.memory_used_size] : [];
    });
    return {
      coldLoadAndCreateMs: loads[0],
      warmLoadAndCreateP95Ms: p95(loads.slice(1)),
      moveP95Ms: p95(moves),
      moveMaxMs: Math.max(...moves),
      parentRssDeltaPerMatchBytes: (process.memoryUsage().rss - rssBefore) / live.length,
      quickjsHeapUsedMeanBytes:
        quickjsHeapAtEnd.length === 0
          ? undefined
          : quickjsHeapAtEnd.reduce((sum, value) => sum + value, 0) / quickjsHeapAtEnd.length,
      quickjsHeapUsedMaxBytes:
        quickjsHeapAtEnd.length === 0 ? undefined : Math.max(...quickjsHeapAtEnd),
      vmChildRssMeanBytes:
        vmChildRss.length === 0
          ? undefined
          : vmChildRss.reduce((sum, value) => sum + value, 0) / vmChildRss.length,
      samples: { matches: live.length, warmLoads: loads.length - 1, moves: moves.length },
      hashesCompared: moves.length + live.length,
    };
  } finally {
    for (const match of live) match.dispose();
  }
}

/** Gate 2 (Q-011): the production client, then idle retirement and resume. */
async function production(source: string, games: Recorded[]) {
  const { buildHash, build: stored } = hostBuild(source);
  const client = new RulesHostClient({ load: async () => stored });
  const creates: number[] = [];
  const moves: number[] = [];
  const activeRss: number[] = [];
  const ids = games.map((_, index) => `harbor-${index}`);
  try {
    await client.load(buildHash);
    // A running server already has its reserve booted; process start-up is measured in coldStart.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    for (const [index, recorded] of games.entries()) {
      const matchId = ids[index] ?? "";
      const started = performance.now();
      await client.create(matchId, { ...recorded.init, buildHash });
      creates.push(performance.now() - started);
      if ((await client.hash(matchId)) !== recorded.hashes[0]) throw Error(`Setup hash ${index}`);
      for (const [step, event] of recorded.events.entries()) {
        const moveStart = performance.now();
        const outcome = await client.apply(matchId, event.seat, event.intent);
        moves.push(performance.now() - moveStart);
        if (!outcome.ok) throw Error(`Game ${index} move ${step + 1} rejected: ${outcome.code}`);
        if ((await client.hash(matchId)) !== recorded.hashes[step + 1])
          throw Error(`Game ${index} hash diverged at seq ${step + 1}`);
      }
      same(await client.views(matchId), recorded.views.end, `Final views ${index}`);
      // Sampled while the match's dedicated process is still active, at the end of its game.
      const pid = client.processId(matchId);
      if (!pid) throw Error("Missing active process");
      activeRss.push(...(await childRss([pid])));
    }
    return {
      settleMs: SETTLE_MS,
      firstCreateMs: creates[0],
      createP95Ms: p95(creates),
      createMaxMs: Math.max(...creates),
      moveP95Ms: p95(moves),
      moveMaxMs: Math.max(...moves),
      activeRssMeanBytes: activeRss.reduce((sum, value) => sum + value, 0) / activeRss.length,
      activeRssMaxBytes: Math.max(...activeRss),
      samples: { matches: ids.length, creates: creates.length, moves: moves.length },
      idle: await idleMeasurements(client, ids),
    };
  } finally {
    client.close();
  }
}

/** The first match after the client starts waits for the initial reserve process to boot. */
async function coldStart(source: string, recorded: Recorded) {
  const { buildHash, build: stored } = hostBuild(source);
  const started = performance.now();
  const client = new RulesHostClient({ load: async () => stored });
  try {
    await client.load(buildHash);
    const createStart = performance.now();
    await client.create("cold", { ...recorded.init, buildHash });
    const created = performance.now();
    if ((await client.hash("cold")) !== recorded.hashes[0]) throw Error("Cold setup hash");
    return {
      clientStartToCreatedMs: created - started,
      createIncludingReserveBootMs: created - createStart,
    };
  } finally {
    client.close();
  }
}

const source = await bundle();
const games = await record();
const firstGame = games[0];
if (!firstGame) throw Error("No games recorded");
// Production runs before the spikes so parent memory is not inflated by 42 earlier sandboxes.
const cold = await coldStart(source, firstGame);
const hosted = await production(source, games);
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model,
  workload: {
    description:
      "Harbor Market bundle (esbuild, as dist/game.js); seeded-bot legal games replayed move by move",
    bundleBytes: Buffer.byteLength(source),
    games: games.length,
    seatCounts: [2, 3, 4],
    events: games.reduce((sum, recorded) => sum + recorded.events.length, 0),
    eventsPerGame: {
      min: Math.min(...games.map((recorded) => recorded.events.length)),
      max: Math.max(...games.map((recorded) => recorded.events.length)),
    },
  },
  criteria: {
    moveP95Ms: 20,
    newMatchLoadMs: 300,
    idleMemoryPerMatchBytes: 16 * 1024 * 1024,
  },
  production: { ...hosted, coldStart: cold },
  quickjs: await spike(source, games, (s) => QuickJsSandbox.load(s)),
  vmProcess: await spike(source, games, (s) => VmProcessSandbox.load(s)),
};
await writeFile(
  "docs/spikes/t08-harbor-market-results.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.info(JSON.stringify(report, null, 2));
