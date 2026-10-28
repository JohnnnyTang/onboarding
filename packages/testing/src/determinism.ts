import { applyIntent, createMatch, hashState, replay } from "@bgp/rules";
import { AcceptedEventSchema, type GameDefinition, type Json, MatchStateSchema } from "@bgp/schema";
import { copy, type MatchRun } from "./runner.js";

/** Compare a fresh replay to the recorded setup and every accepted transition. */
export async function checkDeterminism<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  run: MatchRun<S>,
): Promise<void> {
  if (run.steps.length !== run.events.length + 1) throw new Error("Incomplete hash trace");
  let state = createMatch(def, copy(run.init));
  for (let seq = 0; seq < run.steps.length; seq += 1) {
    const recorded = run.steps[seq];
    if (!recorded) throw new Error("Incomplete hash trace");
    MatchStateSchema.parse(recorded.state);
    const hash = await hashState(state);
    if ((await hashState(recorded.state)) !== recorded.hash || hash !== recorded.hash) {
      throw new Error(`Determinism mismatch at seq ${seq}`);
    }
    const input = run.events[seq];
    if (input !== undefined) {
      const event = AcceptedEventSchema.parse(input);
      if (event.seq !== seq + 1) throw new Error(`Invalid replay sequence at seq ${seq + 1}`);
      const applied = applyIntent(def, state, event.seat, event.intent);
      if (!applied.ok) throw new Error(`Replay rejected at seq ${event.seq}: ${applied.code}`);
      state = applied.state;
    }
  }
  // Exercise the public runtime replay path as well as the per-step comparison.
  if (
    (await hashState(replay(def, copy(run.init), copy(run.events)))) !== (await hashState(state))
  ) {
    throw new Error("Runtime replay final hash mismatch");
  }
}
