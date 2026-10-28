import { applyIntent, createMatch, hashState } from "@bgp/rules";
import {
  type AcceptedEvent,
  AcceptedEventSchema,
  type GameDefinition,
  type Json,
  JsonSchema,
  type MatchInit,
  MatchInitSchema,
  type MatchState,
  Sha256Schema,
  SlugSchema,
} from "@bgp/schema";

export interface GoldenReplay extends MatchInit {
  game: string;
  buildHash: string;
  events: AcceptedEvent[];
  expectedHashes: Record<string, string>;
}

/** Validate the documented golden JSON format without introducing a runtime dependency. */
export function parseGoldenReplay(input: unknown): GoldenReplay {
  const data = JsonSchema.parse(input);
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid golden replay");
  const keys = ["game", "buildHash", "seats", "seed", "options", "events", "expectedHashes"];
  if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) {
    throw new Error("Invalid golden replay fields");
  }
  const init = MatchInitSchema.parse({ seats: data.seats, seed: data.seed, options: data.options });
  if (!Array.isArray(data.events)) throw new Error("Invalid golden events");
  const events = data.events.map((event, index) => {
    const parsed = AcceptedEventSchema.parse(event);
    if (parsed.seq !== index + 1 || !init.seats.includes(parsed.seat))
      throw new Error("Invalid golden event sequence or seat");
    return parsed;
  });
  const hashes = data.expectedHashes;
  if (
    hashes === null ||
    typeof hashes !== "object" ||
    Array.isArray(hashes) ||
    Object.keys(hashes).length === 0
  )
    throw new Error("Golden replay requires expected hashes");
  const expectedHashes: Record<string, string> = {};
  for (const [seq, hash] of Object.entries(hashes)) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(seq) ||
      !Number.isSafeInteger(Number(seq)) ||
      Number(seq) > events.length
    )
      throw new Error("Invalid golden hash sequence");
    expectedHashes[seq] = Sha256Schema.parse(hash);
  }
  return {
    ...init,
    game: SlugSchema.parse(data.game),
    buildHash: Sha256Schema.parse(data.buildHash),
    events,
    expectedHashes,
  };
}

/** Identity is supplied by the game registry/CLI, never inferred from the fixture. */
export async function checkGoldenReplay<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  input: unknown,
  identity: { game: string; buildHash: string },
): Promise<MatchState<S>> {
  const golden = parseGoldenReplay(input);
  if (golden.game !== identity.game || golden.buildHash !== identity.buildHash)
    throw new Error("Golden game/build mismatch");
  let state = createMatch(def, { seats: golden.seats, seed: golden.seed, options: golden.options });
  async function check() {
    const expected = golden.expectedHashes[String(state.ctx.moveNumber)];
    if (expected !== undefined && expected !== (await hashState(state)))
      throw new Error(`Golden hash mismatch at seq ${state.ctx.moveNumber}`);
  }
  await check();
  for (const event of golden.events) {
    const result = applyIntent(def, state, event.seat, event.intent);
    if (!result.ok) throw new Error(`Golden event rejected at seq ${event.seq}: ${result.code}`);
    state = result.state;
    await check();
  }
  return state;
}
