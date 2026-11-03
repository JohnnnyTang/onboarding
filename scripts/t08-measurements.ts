import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RulesHostClient } from "../packages/rules-host/src/index.js";

export function p95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
}

export async function childRss(pids: number[]): Promise<number[]> {
  if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
    throw Error("Invalid process IDs");
  if (process.platform === "win32") {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pids.join(",")}).WorkingSet64 | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const parsed: unknown = JSON.parse(raw);
    const values: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (
      !values.every(
        (value): value is number => typeof value === "number" && Number.isSafeInteger(value),
      )
    )
      throw Error("Invalid RSS samples");
    return values;
  }
  if (process.platform === "linux")
    return Promise.all(
      pids.map(async (pid) => {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        const kib = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1]);
        if (!Number.isSafeInteger(kib)) throw Error("Missing RSS sample");
        return kib * 1024;
      }),
    );
  throw Error("RSS measurement supports Windows and Linux");
}

/** A one-file build in the BuildStore shape: the entry digest and the build-index digest. */
export function hostBuild(source: string) {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const buildHash = createHash("sha256").update(`game.js\t${sourceHash}\n`).digest("hex");
  return {
    buildHash,
    build: { entry: "game.js", files: { "game.js": sourceHash }, source },
  };
}

/** Waits for idle retirement, measures the shared reserve and resumes every match by hash. */
export async function idleMeasurements(client: RulesHostClient, matches: string[]) {
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
    note: "Per-idle-match value amortizes the one shared spare across the idle matches; parent absolute memory is separate and includes the measurement runner. Active process RSS is reported separately.",
  };
}
