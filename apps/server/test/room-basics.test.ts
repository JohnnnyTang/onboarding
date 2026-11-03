import { MatchSummarySchema } from "@bgp/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchEvents } from "../src/db/schema.js";
import {
  join,
  nextUpdate,
  type RoomEnv,
  type RoomServer,
  startMatch,
  startRoomEnv,
  TestClient,
  uniqueSlug,
  ViewTracker,
} from "./room-fixture.js";
import { signalPackage } from "./signal-game.js";

let env: RoomEnv;
let server: RoomServer;
beforeAll(async () => {
  env = await startRoomEnv();
  server = await env.startServer({ idleMs: 100 });
});
afterAll(async () => {
  await env?.close();
});

describe("room server basics", () => {
  it("welcomes seats, applies a move, stores it before the patch and tracks presence", async () => {
    const match = await startMatch(env, server, signalPackage(uniqueSlug("signal")), 2);
    const [owner, guest] = match.seats;
    if (!owner || !guest) throw new Error("Expected two seats");
    const a = await join(server, match.matchId, owner);
    expect(a.welcome).toMatchObject({ seat: "0", seq: 0, match: { id: match.matchId } });
    expect(a.welcome.view.game).toMatchObject({ count: 0 });
    const b = await join(server, match.matchId, guest);
    expect(b.welcome.seat).toBe("1");
    expect(b.welcome.match.seats.map((seat) => seat.connected)).toEqual([true, true]);
    const presence = await a.client.take("presence", (m) => m.seats.every((s) => s.connected));
    expect(presence.seats.map((seat) => seat.name)).toEqual(["Owner", "Guest 1"]);

    const summary = MatchSummarySchema.parse(
      (await server.call("GET", `/api/matches/${match.matchId}`, { token: match.owner })).json(),
    );
    expect(summary.seats.map((seat) => seat.connected)).toEqual([true, true]);

    const trackerA = new ViewTracker(a.welcome);
    const trackerB = new ViewTracker(b.welcome);
    a.client.send({ t: "move", clientSeq: 0, intent: { move: "step", args: { n: 2 } } });
    const patchA = await nextUpdate(a.client, 1);
    const [stored] = await env.connection.db
      .select()
      .from(matchEvents)
      .where(and(eq(matchEvents.matchId, match.matchId), eq(matchEvents.seq, 1)));
    expect(stored).toMatchObject({ seat: "0", intent: { move: "step", args: { n: 2 } } });
    expect(patchA).toMatchObject({ t: "patch", cause: { seat: "0", clientSeq: 0, move: "step" } });
    const patchB = await nextUpdate(b.client, 1);
    expect(patchB).toMatchObject({ t: "patch", cause: { seat: "0", move: "step" } });
    expect(patchB.t === "patch" && patchB.cause.clientSeq).toBe(undefined);
    trackerA.apply(patchA);
    trackerB.apply(patchB);
    expect(trackerA.view.game).toMatchObject({ count: 2 });
    expect(trackerB.view.game).toMatchObject({ count: 2 });
    // The mover's new secret reached only the mover.
    const secret = (trackerA.view.game as { mine: string }).mine;
    expect(secret).toMatch(/^secret-/);
    expect(b.client.frames.join("")).not.toContain(secret);

    await b.client.close();
    const left = await a.client.take("presence", (m) => m.seats[1]?.connected === false);
    expect(left.seats.map((seat) => seat.connected)).toEqual([true, false]);
    await a.client.close();
    expect(a.client.invalid).toEqual([]);
  });

  it("answers ping and closes a connection that never says hello", async () => {
    const fast = await env.startServer({ helloTimeoutMs: 100 });
    try {
      const client = await TestClient.open(fast.url);
      const error = await client.take("error");
      expect(error).toMatchObject({ code: "BAD_MESSAGE", fatal: true });
      expect(await client.closedPromise).toBe(1008);
    } finally {
      await fast.close();
    }
  });
});
