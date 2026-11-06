import { parentPort, workerData } from "node:worker_threads";
import { type CheckOptions, type CheckReport, checkDefinition, runGameChecks } from "./checks.js";
import { type Digest, lockDown } from "./lockdown.js";

// Worker thread for `bgp validate`. It has its own globals, so it can lock them down like the
// rules host before the game bundle is evaluated, without touching the CLI's own process.

export interface CheckRequest extends Omit<CheckOptions, "onProgress"> {
  source: string;
}

export type CheckMessage =
  | { t: "progress" }
  | { t: "done"; report: CheckReport; touched: string[] }
  | { t: "failed"; stage: "load" | "shape" | "checks"; message: string; touched: string[] };

const port = parentPort;
if (!port) throw new Error("check-worker must run as a worker thread");
const request = workerData as CheckRequest;
const send = (message: CheckMessage) => port.postMessage(message);
const subtle = globalThis.crypto.subtle;
const digest: Digest = (algorithm, data) => subtle.digest(algorithm, new Uint8Array(data));
// Data URLs are evaluated as ES modules; the bundle has no imports to resolve.
const url = `data:text/javascript;base64,${Buffer.from(request.source).toString("base64")}`;
const touched = lockDown(globalThis, digest);
const names = () => [...touched].sort();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function check(): Promise<CheckMessage> {
  let definition: unknown;
  try {
    definition = ((await import(url)) as { default?: unknown }).default;
  } catch (error) {
    return { t: "failed", stage: "load", message: errorText(error), touched: names() };
  }
  if (!checkDefinition(definition)) {
    const message = "The bundle's default export is not a GameDefinition (sdk: 1)";
    return { t: "failed", stage: "shape", message, touched: names() };
  }
  try {
    const report = await runGameChecks(definition, {
      ...request,
      onProgress: () => send({ t: "progress" }),
    });
    return { t: "done", report, touched: names() };
  } catch (error) {
    return { t: "failed", stage: "checks", message: errorText(error), touched: names() };
  }
}

send(await check());
