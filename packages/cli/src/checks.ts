import { viewFor } from "@bgp/rules";
import {
  ActionButtonSchema,
  type ComponentsFile,
  defaultOptions,
  type GameDefinition,
  GameDefinitionSchema,
  type Json,
  type Manifest,
  type MatchState,
  type SeatId,
} from "@bgp/schema";
import { checkDeterminism, type MatchRun, runMatch } from "@bgp/testing";
import { checkStep, type LeakProblem, SeenMemory } from "./leak-check.js";

// The checks `bgp validate` runs on a loaded game definition: random-bot games from several
// seeds and seat counts, a determinism check of each, and the generic leak checks at every
// step for every seat. The caller loads the definition (in a locked-down worker, see
// check-worker.ts) and owns time limits.

export interface CheckOptions {
  manifest: Manifest;
  components: ComponentsFile;
  /**
   * Which games to play, by index: game i uses seed firstSeed + i and seat counts cycle from
   * players.min to players.max. Several workers can share one run.
   */
  indices: readonly number[];
  firstSeed: number;
  /** Moves per game before the run stops with a warning. */
  maxMoves: number;
  /** Called after every step, so the caller can tell a slow game from a stuck one. */
  onProgress?(): void;
}

export interface GameRunSummary {
  index: number;
  seed: number;
  seats: number;
  moves: number;
  stop: MatchRun<Json>["stop"];
}

export interface CheckReport {
  runs: GameRunSummary[];
  errors: string[];
  warnings: string[];
}

/** JSON copy; structuredClone is locked in the worker, as it is absent from the rules host. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seatsFor(count: number): SeatId[] {
  return Array.from({ length: count }, (_, seat) => String(seat));
}

const REJECTED = /^Bot move rejected at seq (\d+): ([A-Z_]+)$/;

/** Explains a runner failure in terms of the developer's code. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const rejected = REJECTED.exec(message);
  if (rejected) {
    const [, seq, code] = rejected;
    return code === "GAME_ERROR"
      ? `move ${seq} from legalMoves failed with GAME_ERROR: the move threw, or left state that is not integer-only JSON`
      : `legalMoves offered move ${seq}, which the game rejected with ${code}`;
  }
  if (message === "randomBot requires legalMoves or a custom bot") {
    return "the game has no legalMoves; bgp validate plays random games from legalMoves";
  }
  return message;
}

/**
 * Calls `present` (and `actions`) for every seat and the spectator at one state, then runs
 * the leak checks across them.
 */
function checkState(
  def: GameDefinition<Json, Json>,
  state: MatchState<Json>,
  components: ComponentsFile,
  memory: SeenMemory,
): LeakProblem[] {
  const problems: LeakProblem[] = [];
  const outputs = [...state.ctx.seats, null].map((seat) => {
    const view = viewFor(def, state, seat);
    const info = { seat, components: copy(components) };
    const snapshot = def.present(copy(view), info);
    if (seat !== null && def.actions && state.result === null) {
      const buttons = def.actions(copy(view), info, []);
      if (
        !Array.isArray(buttons) ||
        !buttons.every((b) => ActionButtonSchema.safeParse(b).success)
      ) {
        problems.push({ seat, message: `Seat ${seat}'s actions are not valid ActionButtons` });
      }
    }
    return { seat, view, snapshot };
  });
  return [...checkStep(components, state.game, outputs, memory), ...problems];
}

export function checkDefinition(value: unknown): value is GameDefinition<Json, Json> {
  return GameDefinitionSchema.safeParse(value).success;
}

export async function runGameChecks(
  def: GameDefinition<Json, Json>,
  options: CheckOptions,
): Promise<CheckReport> {
  const { manifest, components } = options;
  const report: CheckReport = { runs: [], errors: [], warnings: [] };
  const { min, max } = manifest.players;
  const gameOptions = defaultOptions(manifest);
  for (const index of options.indices) {
    const seed = (options.firstSeed + index) >>> 0;
    const count = min + (index % (max - min + 1));
    const init = { seats: seatsFor(count), seed, options: gameOptions };
    const label = `Game ${index + 1} (seed ${seed}, ${count} seats)`;
    let leak: string | null = null;
    const memory = new SeenMemory();
    let run: MatchRun<Json>;
    try {
      run = await runMatch(def, init, {
        botSeed: seed,
        maxMoves: options.maxMoves,
        onStep({ state }) {
          options.onProgress?.();
          if (leak !== null) return;
          const [problem] = checkState(def, state, components, memory);
          if (problem) leak = `${label}, after move ${state.ctx.moveNumber}: ${problem.message}`;
        },
      });
    } catch (error) {
      report.errors.push(`${label}: ${describeFailure(error)}`);
      continue;
    }
    report.runs.push({ index, seed, seats: count, moves: run.events.length, stop: run.stop });
    if (leak !== null) report.errors.push(leak);
    try {
      await checkDeterminism(def, run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(
        `${label}: not deterministic (${message}); the same seed and moves must give the same state`,
      );
    }
    if (run.stop === "move-limit") {
      report.warnings.push(`${label}: no result after ${options.maxMoves} moves`);
    } else if (run.stop === "no-legal-moves") {
      report.warnings.push(
        `${label}: no seat had a legal move after ${run.events.length} moves, but the game has no result`,
      );
    }
  }
  return report;
}
