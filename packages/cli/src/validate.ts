import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ValidationError } from "@bgp/schema";
import { bundleGame } from "./build.js";
import type { CheckMessage, CheckRequest } from "./check-worker.js";
import type { GameRunSummary } from "./checks.js";
import { type GamePackage, PackageError } from "./game-package.js";
import { adviceFor } from "./lockdown.js";
import { checkVersionFiles, collectVersionFiles } from "./package-files.js";

export interface ValidateOptions {
  games: number;
  firstSeed: number;
  maxMoves: number;
  /** Longest silence from a worker, in ms, before the game counts as stuck. */
  stepTimeoutMs: number;
  /** Worker threads that share the games. */
  workers: number;
}

export const DEFAULT_VALIDATE_OPTIONS: ValidateOptions = {
  games: 20,
  firstSeed: 1,
  maxMoves: 1000,
  stepTimeoutMs: 5000,
  workers: Math.max(1, Math.min(4, availableParallelism() - 1)),
};

export interface ValidateResult {
  ok: boolean;
  /** File and package errors, with the file or field they concern. */
  packageErrors: ValidationError[];
  /** Errors from running the game: shape, forbidden APIs, determinism, leaks. */
  gameErrors: string[];
  warnings: string[];
  runs: GameRunSummary[];
}

/** Memory cap for the worker, so an allocation loop fails instead of exhausting the machine. */
const WORKER_HEAP_MB = 512;

/**
 * The bundled worker (scripts/build-cli-worker.ts). It always runs from dist, also when this
 * module runs from source in tests, whose script bundles it first: a TypeScript loader inside
 * the worker would itself read locked globals while importing the game.
 */
function workerUrl(): URL {
  const fromSource = fileURLToPath(import.meta.url).endsWith(".ts");
  return new URL(
    fromSource ? "../dist/validate-worker.js" : "./validate-worker.js",
    import.meta.url,
  );
}

type WorkerOutcome =
  | Exclude<CheckMessage, { t: "progress" }>
  | { t: "stuck" | "crashed"; message: string };

/** Runs the game checks in a locked-down worker thread, stopping it if it goes quiet. */
function runInWorker(request: CheckRequest, stepTimeoutMs: number): Promise<WorkerOutcome> {
  const worker = new Worker(workerUrl(), {
    workerData: request,
    // Never inherit loader flags (tsx, test runners): they would run inside the lockdown.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    stdout: true,
    stderr: true,
  });
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const seconds = stepTimeoutMs / 1000;
        finish({
          t: "stuck",
          message: `Game code did not return within ${seconds} s; does setup, a move, playerView or present loop forever?`,
        });
      }, stepTimeoutMs);
    };
    arm();
    worker.on("message", (message: CheckMessage) => {
      if (message.t === "progress") arm();
      else finish(message);
    });
    worker.on("error", (error: Error & { code?: string }) => {
      finish({
        t: "crashed",
        message:
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? `Game code used more than ${WORKER_HEAP_MB} MB of memory`
            : `The validation worker failed: ${error.message}`,
      });
    });
    worker.on("exit", () => finish({ t: "crashed", message: "The validation worker stopped" }));
  });
}

function touchedErrors(touched: Iterable<string>): string[] {
  return [...touched]
    .sort()
    .map((name) => `Game code used ${name}, which games may not use: ${adviceFor(name)}`);
}

const FAILED_STAGE = {
  load: "The bundle failed to load: ",
  shape: "",
  checks: "The checks failed: ",
} as const;

/** Splits game indices 0..games-1 into contiguous chunks, one per worker. */
export function chunkGames(games: number, workers: number): number[][] {
  const count = Math.max(1, Math.min(workers, games));
  const chunks: number[][] = [];
  for (let worker = 0, start = 0; worker < count; worker += 1) {
    const size = Math.floor(games / count) + (worker < games % count ? 1 : 0);
    chunks.push(Array.from({ length: size }, (_, offset) => start + offset));
    start += size;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/** Merges worker outcomes in chunk order, so errors stay in game order. */
function mergeOutcomes(outcomes: readonly WorkerOutcome[]) {
  const touched = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const runs: GameRunSummary[] = [];
  for (const outcome of outcomes) {
    if (outcome.t === "done") {
      for (const name of outcome.touched) touched.add(name);
      errors.push(...outcome.report.errors);
      warnings.push(...outcome.report.warnings);
      runs.push(...outcome.report.runs);
    } else if (outcome.t === "failed") {
      for (const name of outcome.touched) touched.add(name);
      errors.push(FAILED_STAGE[outcome.stage] + outcome.message);
    } else {
      errors.push(outcome.message);
    }
  }
  // Every worker loads the same bundle, so load and shape failures repeat.
  return { errors: [...touchedErrors(touched), ...new Set(errors)], warnings, runs };
}

/** `bgp validate`: every check that can run before publishing. */
export async function validateGame(
  pkg: GamePackage,
  options: ValidateOptions = DEFAULT_VALIDATE_OPTIONS,
): Promise<ValidateResult> {
  let source: string | null = null;
  const packageErrors: ValidationError[] = [];
  if (pkg.manifest.mode === "enforced") {
    try {
      source = (await bundleGame(pkg)).source;
    } catch (error) {
      if (!(error instanceof PackageError)) throw error;
      packageErrors.push(...error.errors);
    }
  }
  const files = await collectVersionFiles(pkg, source);
  packageErrors.push(...checkVersionFiles(pkg, files));
  const result: ValidateResult = {
    ok: false,
    packageErrors,
    gameErrors: [],
    warnings: [],
    runs: [],
  };
  if (source !== null && options.games > 0) {
    const request = {
      source,
      manifest: pkg.manifest,
      components: pkg.components,
      firstSeed: options.firstSeed,
      maxMoves: options.maxMoves,
    };
    const outcomes = await Promise.all(
      chunkGames(options.games, options.workers).map((indices) =>
        runInWorker({ ...request, indices }, options.stepTimeoutMs),
      ),
    );
    const merged = mergeOutcomes(outcomes);
    result.gameErrors = merged.errors;
    result.warnings = merged.warnings;
    result.runs = merged.runs;
  }
  result.ok = result.packageErrors.length === 0 && result.gameErrors.length === 0;
  return result;
}
