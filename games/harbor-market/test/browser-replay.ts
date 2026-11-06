import type { AcceptedEvent, MatchInit } from "@bgp/schema";
import { checkReplayHashes, runMatch } from "@bgp/testing";
import game from "../src/index.js";

export async function record(init: MatchInit, botSeed: number) {
  const run = await runMatch(game, init, { botSeed, maxMoves: 2000 });
  if (run.stop !== "finished") throw new Error(`Harbor Market stopped: ${run.stop}`);
  return { init, events: run.events, hashes: run.steps.map((step) => step.hash) };
}

export function verify(trace: { init: MatchInit; events: AcceptedEvent[]; hashes: string[] }) {
  return checkReplayHashes(game, trace.init, trace.events, trace.hashes);
}
