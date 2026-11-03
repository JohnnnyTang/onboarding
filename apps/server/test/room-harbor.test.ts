import type { RulesHostClient } from "@bgp/rules-host";
import { type ClientView, type MoveIntent, ReplayResponseSchema } from "@bgp/schema";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchEvents, matches, matchSnapshots } from "../src/db/schema.js";
import { harborMarket } from "./api-fixture.js";
import {
  type ActiveMatch,
  join,
  nextUpdate,
  type RoomEnv,
  type RoomServer,
  startMatch,
  startRoomEnv,
  type TestClient,
  uniqueSlug,
  ViewTracker,
  withSlug,
} from "./room-fixture.js";

type Card = { id: string; good: string; value: number };
type HarborView = { hand: Card[]; deckCount: number; market: Card[] };
type HarborState = {
  deck: string[];
  boxed: string[];
  hands: Record<string, string[]>;
};

/** A scripted player that decides from its own view only, like a browser would. */
function botMove(view: ClientView): MoveIntent {
  const game = view.game as HarborView;
  if (view.ctx.phase === "discard") {
    const cards = game.hand.slice(0, game.hand.length - 6).map((card) => card.id);
    return { move: "discard", args: { cards } };
  }
  const goods = new Map<string, string[]>();
  for (const card of game.hand) goods.set(card.good, [...(goods.get(card.good) ?? []), card.id]);
  const set = [...goods.values()].find((ids) => ids.length >= 2);
  if (set) return { move: "ship", args: { cards: set } };
  if (game.deckCount > 0) return { move: "restock" };
  const [hand] = game.hand;
  const [market] = game.market;
  if (hand && market) return { move: "swap", args: { hand: hand.id, market: market.id } };
  return { move: "pass" };
}

interface Player {
  seat: string;
  client: TestClient;
  tracker: ViewTracker;
  clientSeq: number;
  scanned: number;
}

interface Table {
  env: RoomEnv;
  match: ActiveMatch;
  mirror: RulesHostClient;
  mirrorId: string;
  players: Player[];
  steps: number;
}

let env: RoomEnv;
beforeAll(async () => {
  env = await startRoomEnv();
});
afterAll(async () => {
  await env?.close();
});

async function harborTable(server: RoomServer, seatCount: number): Promise<Table> {
  const match = await startMatch(env, server, withSlug(await harborMarket(), uniqueSlug("hm")), 3);
  // The oracle: the same build, seed and moves in a separate rules host.
  const mirror = env.mirror();
  const mirrorId = `mirror-${match.matchId}`;
  await mirror.load(match.buildHash);
  await mirror.create(mirrorId, {
    buildHash: match.buildHash,
    seats: Array.from({ length: seatCount }, (_, seat) => String(seat)),
    seed: match.seed,
    options: match.options,
  });
  const table: Table = { env, match, mirror, mirrorId, players: [], steps: 0 };
  await connectAll(table, server);
  return table;
}

async function connectAll(table: Table, server: RoomServer, lastSeq?: number): Promise<void> {
  table.players = [];
  for (const [index, auth] of table.match.seats.entries()) {
    const { client, welcome } = await join(server, table.match.matchId, auth, lastSeq);
    expect(welcome.seat).toBe(String(index));
    table.players.push({
      seat: String(index),
      client,
      tracker: new ViewTracker(welcome),
      clientSeq: 0,
      scanned: 0,
    });
  }
  await checkViews(table);
}

/** INT-LEAK: each seat's reconstructed view equals its playerView; no hidden ID reached it. */
async function checkViews(table: Table): Promise<void> {
  const views = await table.mirror.views(table.mirrorId);
  const state = (await table.mirror.exportState(table.mirrorId)).game as HarborState;
  for (const player of table.players) {
    expect(player.tracker.view).toEqual(views[player.seat]);
    const hidden = [
      ...state.deck,
      ...state.boxed,
      ...Object.entries(state.hands).flatMap(([seat, ids]) => (seat === player.seat ? [] : ids)),
    ];
    const text = player.client.frames.slice(player.scanned).join("\n");
    player.scanned = player.client.frames.length;
    expect(hidden.filter((id) => text.includes(id))).toEqual([]);
    expect(text).not.toMatch(/"rng"|"seed"/);
    expect(player.client.invalid).toEqual([]);
  }
}

function activePlayer(table: Table): Player {
  const seat = table.players[0]?.tracker.view.ctx.currentSeat;
  const player = table.players.find((candidate) => candidate.seat === seat);
  if (!player) throw new Error("No active player");
  return player;
}

const finished = (table: Table) => table.players[0]?.tracker.view.result != null;

async function step(table: Table): Promise<void> {
  const mover = activePlayer(table);
  const intent = botMove(mover.tracker.view);
  const seq = mover.tracker.seq + 1;
  mover.client.send({ t: "move", clientSeq: mover.clientSeq++, intent });
  for (const [index, player] of table.players.entries()) {
    const update = await nextUpdate(player.client, seq);
    if (index === 0) {
      // Persistence before broadcast: the event row exists once any patch arrived.
      const stored = await table.env.connection.db
        .select({ seq: matchEvents.seq })
        .from(matchEvents)
        .where(and(eq(matchEvents.matchId, table.match.matchId), eq(matchEvents.seq, seq)));
      expect(stored).toHaveLength(1);
    }
    if (update.t === "patch") {
      expect(update.cause).toEqual({
        seat: mover.seat,
        move: intent.move,
        ...(player === mover ? { clientSeq: mover.clientSeq - 1 } : {}),
      });
    }
    player.tracker.apply(update);
  }
  const outcome = await table.mirror.apply(table.mirrorId, mover.seat, intent);
  expect(outcome.ok).toBe(true);
  table.steps++;
  await checkViews(table);
}

async function playToEnd(table: Table): Promise<void> {
  while (!finished(table)) {
    if (table.steps > 600) throw new Error("Harbor Market did not finish");
    await step(table);
  }
}

/** INT-REPLAY: rebuild from match_events in a fresh host; final hash equals the stored one. */
async function checkReplay(server: RoomServer, table: Table): Promise<void> {
  const { db } = env.connection;
  const [row] = await db.select().from(matches).where(eq(matches.id, table.match.matchId));
  expect(row?.status).toBe("finished");
  const snapshots = await db
    .select({ seq: matchSnapshots.seq, hash: matchSnapshots.stateHash })
    .from(matchSnapshots)
    .where(eq(matchSnapshots.matchId, table.match.matchId))
    .orderBy(asc(matchSnapshots.seq));
  const lastSeq = row?.lastSeq ?? -1;
  const cadence = Array.from({ length: Math.floor((lastSeq - 1) / 50) + 1 }, (_, i) => i * 50);
  expect(snapshots.map((snapshot) => snapshot.seq)).toEqual([...cadence, lastSeq]);

  const replay = ReplayResponseSchema.parse(
    (
      await server.call("GET", `/api/matches/${table.match.matchId}/replay`, {
        token: table.match.owner,
      })
    ).json(),
  );
  expect(replay.events).toHaveLength(lastSeq);
  const host = env.mirror();
  const id = `replay-${table.match.matchId}`;
  await host.load(replay.buildHash);
  await host.create(id, {
    buildHash: replay.buildHash,
    seats: replay.seats,
    seed: replay.seed,
    options: replay.options,
  });
  for (const event of replay.events) {
    const outcome = await host.apply(id, event.seat, event.intent);
    expect(outcome.ok && outcome.event.seq).toBe(event.seq);
  }
  expect(await host.hash(id)).toBe(snapshots.at(-1)?.hash);
  const final = await host.exportState(id);
  expect(row?.result).toEqual(final.result);
  host.close();
}

describe("Harbor Market through the room server", () => {
  it("INT-LEAK and INT-REPLAY: a 3-seat match to the end matches every playerView and replays exactly", async () => {
    const server = await env.startServer();
    try {
      const table = await harborTable(server, 3);
      await playToEnd(table);
      const state = await table.mirror.exportState(table.mirrorId);
      for (const player of table.players) {
        expect((await player.client.take("ended")).result).toEqual(state.result);
      }
      const late = activePlayer(table);
      late.client.send({ t: "move", clientSeq: late.clientSeq++, intent: { move: "pass" } });
      expect(await late.client.take("rejected")).toMatchObject({ code: "MATCH_FINISHED" });
      await checkReplay(server, table);
      await checkViews(table);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("sends a snapshot after resync to a client that dropped a patch", async () => {
    const server = await env.startServer();
    try {
      const table = await harborTable(server, 3);
      await step(table);
      const [dropper] = table.players;
      if (!dropper) throw new Error("Missing player");
      // Advance the match, but let the first seat lose that patch.
      const mover = activePlayer(table);
      const intent = botMove(mover.tracker.view);
      const seq = mover.tracker.seq + 1;
      mover.client.send({ t: "move", clientSeq: mover.clientSeq++, intent });
      for (const player of table.players) {
        const update = await nextUpdate(player.client, seq);
        if (player !== dropper) player.tracker.apply(update);
      }
      expect((await table.mirror.apply(table.mirrorId, mover.seat, intent)).ok).toBe(true);
      expect(dropper.tracker.seq).toBe(seq - 1);
      dropper.client.send({ t: "resync" });
      const snapshot = await dropper.client.take("snapshot");
      expect(snapshot.seq).toBe(seq);
      dropper.tracker.apply(snapshot);
      await checkViews(table);
      // Later patches apply cleanly on top of the snapshot.
      await step(table);
      await step(table);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("INT-RECOVERY: survives a killed rules host process and a server restart with the same hash", async () => {
    const first = await env.startServer();
    let second: RoomServer | undefined;
    try {
      const table = await harborTable(first, 3);
      for (let index = 0; index < 5; index++) await step(table);
      const hash = await table.mirror.hash(table.mirrorId);
      expect(await first.engine.hash(table.match.matchId)).toBe(hash);

      const pid = first.engine.processId(table.match.matchId);
      if (!pid) throw new Error("No rules host process");
      process.kill(pid, "SIGKILL");
      for (const player of table.players) {
        const snapshot = await player.client.take("snapshot", undefined, 10_000);
        expect(snapshot.seq).toBe(player.tracker.seq);
        player.tracker.apply(snapshot);
      }
      expect(first.engine.processId(table.match.matchId)).not.toBe(pid);
      expect(await first.engine.hash(table.match.matchId)).toBe(hash);
      await checkViews(table);
      for (let index = 0; index < 3; index++) await step(table);

      // A server restart loses every in-memory checkpoint; the room rebuilds from storage.
      const seq = table.players[0]?.tracker.seq ?? 0;
      await first.close();
      for (const player of table.players) expect(await player.client.closedPromise).toBe(1001);
      second = await env.startServer();
      await connectAll(table, second, seq);
      for (const player of table.players) expect(player.tracker.seq).toBe(seq);
      expect(await second.engine.hash(table.match.matchId)).toBe(
        await table.mirror.hash(table.mirrorId),
      );
      await playToEnd(table);
      await checkReplay(second, table);
    } finally {
      await first.close();
      await second?.close();
    }
  }, 120_000);
});
