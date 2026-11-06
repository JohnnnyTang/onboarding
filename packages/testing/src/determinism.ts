import { applyIntent, createMatch, hashState, replay } from "@bgp/rules";
import {
  type AcceptedEvent,
  AcceptedEventSchema,
  type GameDefinition,
  type Json,
  type MatchInit,
  MatchStateSchema,
} from "@bgp/schema";
import { copy, type MatchRun } from "./runner.js";

/** Compare a fresh replay to the recorded setup and every accepted transition. */
export async function checkDeterminism<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  run: MatchRun<S>,
): Promise<void> {
  if (run.steps.length !== run.events.length + 1) throw new Error("Incomplete hash trace");
  await checkReplayHashes(
    def,
    run.init,
    run.events,
    run.steps.map((step) => step.hash),
  );
  for (const [seq, recorded] of run.steps.entries()) {
    MatchStateSchema.parse(recorded.state);
    if ((await hashState(recorded.state)) !== recorded.hash) {
      throw new Error(`Determinism mismatch at seq ${seq}`);
    }
  }
}

/** Check the setup and every replayed event against a trace recorded in any engine. */
export async function checkReplayHashes<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  init: MatchInit,
  events: AcceptedEvent[],
  hashes: readonly string[],
): Promise<void> {
  if (hashes.length !== events.length + 1) throw new Error("Incomplete hash trace");
  let state = createMatch(def, copy(init));
  for (let seq = 0; seq < hashes.length; seq += 1) {
    if ((await hashState(state)) !== hashes[seq]) {
      throw new Error(`Determinism mismatch at seq ${seq}`);
    }
    const input = events[seq];
    if (input !== undefined) {
      const event = AcceptedEventSchema.parse(input);
      if (event.seq !== seq + 1) throw new Error(`Invalid replay sequence at seq ${seq + 1}`);
      const applied = applyIntent(def, state, event.seat, event.intent);
      if (!applied.ok) throw new Error(`Replay rejected at seq ${event.seq}: ${applied.code}`);
      state = applied.state;
    }
  }
  // Exercise the public runtime replay path as well as the per-step comparison.
  if ((await hashState(replay(def, copy(init), copy(events)))) !== hashes.at(-1)) {
    throw new Error("Runtime replay final hash mismatch");
  }
}
