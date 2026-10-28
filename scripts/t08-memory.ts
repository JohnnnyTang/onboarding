import { type ChildProcess, fork, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import type { GameDefinition, Json } from "@bgp/schema";
import { HOST_PROTOCOL_VERSION, type HostCommand, HostResponseSchema } from "@bgp/schema";
import { applyIntent, createMatch, hashState } from "../packages/rules/src/index.js";
import { GAME_SOURCE, INIT } from "../packages/rules-host/test/fixtures.js";
import { childRss, p95 } from "./t08-measurements.js";

const profiles = [
  { name: "original", flags: ["--max-old-space-size=128"] },
  {
    name: "compact-128",
    flags: ["--max-old-space-size=128", "--max-semi-space-size=1", "--optimize-for-size"],
  },
  {
    name: "compact-64",
    flags: ["--max-old-space-size=64", "--max-semi-space-size=1", "--optimize-for-size"],
  },
  {
    name: "compact-32",
    flags: ["--max-old-space-size=32", "--max-semi-space-size=1", "--optimize-for-size"],
  },
  {
    name: "baseline-js",
    flags: [
      "--max-old-space-size=64",
      "--max-semi-space-size=1",
      "--optimize-for-size",
      "--max-opt=0",
    ],
  },
  {
    name: "baseline-wasm",
    flags: [
      "--max-old-space-size=64",
      "--max-semi-space-size=1",
      "--optimize-for-size",
      "--liftoff-only",
    ],
  },
];

class Probe {
  private id = 0;
  readonly child: ChildProcess;
  constructor(flags: string[]) {
    const dist = fileURLToPath(new URL("../packages/rules-host/dist/", import.meta.url));
    this.child = fork(new URL("../packages/rules-host/dist/host-entry.js", import.meta.url), [], {
      execArgv: ["--permission", `--allow-fs-read=${dist}`, ...flags],
      env: {},
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child.on("error", () => {});
  }
  call(command: HostCommand): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const cleanup = () => {
        clearTimeout(timer);
        this.child.removeListener("message", message);
        this.child.removeListener("exit", failed);
      };
      const failed = () => {
        cleanup();
        reject(Error("Profile failed"));
      };
      const message = (raw: unknown) => {
        cleanup();
        const reply = HostResponseSchema.safeParse(raw);
        if (!reply.success || !reply.data.ok || reply.data.id !== id)
          return reject(Error("Invalid probe reply"));
        resolve(reply.data.value);
      };
      const timer = setTimeout(failed, 1000);
      this.child.once("message", message);
      this.child.once("exit", failed);
      this.child.send({ v: HOST_PROTOCOL_VERSION, id, command }, (error) => {
        if (error) failed();
      });
    });
  }
  dispose(): void {
    this.child.kill("SIGKILL");
  }
}

async function baseline(): Promise<number[]> {
  const children: ChildProcess[] = [];
  try {
    for (let index = 0; index < 5; index++) {
      const child = spawn(
        process.execPath,
        ["--permission", "--eval", "process.on('message', () => {}); process.send({ready:true});"],
        { env: {}, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(Error("Baseline exited")));
      });
    }
    return await childRss(
      children.map((child) => {
        if (!child.pid) throw Error("Missing pid");
        return child.pid;
      }),
    );
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
}

async function measure(flags: string[]) {
  const probes: Probe[] = [];
  const loads: number[] = [];
  const moves: number[] = [];
  try {
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      const probe = new Probe(flags);
      probes.push(probe);
      await probe.call({
        op: "load",
        source: GAME_SOURCE,
        timeoutMs: 1000,
        memoryLimitBytes: 64 * 1024 * 1024,
      });
      await probe.call({ op: "create", init: INIT });
      await probe.call({ op: "exportState" });
      loads.push(performance.now() - start);
    }
    const rss = await childRss(
      probes.map((probe) => {
        if (!probe.child.pid) throw Error("Missing pid");
        return probe.child.pid;
      }),
    );
    const probe = probes[0];
    if (!probe) throw Error("Missing probe");
    const module = (await import(`data:text/javascript,${encodeURIComponent(GAME_SOURCE)}`)) as {
      default: GameDefinition<Json>;
    };
    let state = createMatch(module.default, INIT);
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      await probe.call({ op: "apply", seat: "0", intent: { move: "tick" } });
      moves.push(performance.now() - start);
      const result = applyIntent(module.default, state, "0", { move: "tick" });
      if (!result.ok) throw Error("Fixture rejected");
      state = result.state;
      if ((await probe.call({ op: "hash" })) !== (await hashState(state)))
        throw Error("Hash mismatch");
    }
    return {
      coldCreateMs: loads[0],
      warmCreateP95Ms: p95(loads.slice(1)),
      moveP95Ms: p95(moves),
      childRssBytes: rss,
      childRssMeanBytes: rss.reduce((sum, value) => sum + value, 0) / rss.length,
      deterministicSteps: 100,
    };
  } finally {
    for (const probe of probes) probe.dispose();
  }
}

const label = process.argv[2] ?? "current";
if (!/^[a-z0-9-]{1,32}$/.test(label)) throw Error("Invalid report label");
const results = [];
for (const profile of profiles) {
  const result = await measure(profile.flags);
  results.push({ ...profile, ...result });
  console.info(
    `${profile.name}: ${(result.childRssMeanBytes / 1024 / 1024).toFixed(2)} MiB; move p95 ${result.moveP95Ms.toFixed(2)} ms`,
  );
}
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model,
  label,
  samplesPerProfile: 5,
  bareNodeRssBytes: await baseline(),
  profiles: results,
};
await writeFile(`docs/spikes/t08-memory-${label}.json`, `${JSON.stringify(report, null, 2)}\n`);
