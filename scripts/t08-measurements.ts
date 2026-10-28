import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

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
