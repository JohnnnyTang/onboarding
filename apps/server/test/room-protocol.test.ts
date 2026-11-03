import { ErrorCodeSchema, HttpErrorSchema, type MatchState } from "@bgp/schema";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matches, matchSnapshots } from "../src/db/schema.js";
import {
  type ActiveMatch,
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

/** Every error code a test in this file produced, checked against the contract at the end. */
const produced = new Set<string>();
function saw(message: { code: string }): void {
  produced.add(message.code);
}

const signal = (seatCount = 2, options?: { start?: boolean }) =>
  startMatch(env, server, signalPackage(uniqueSlug("signal")), seatCount, options);

async function seated(match: ActiveMatch) {
  const [owner, guest] = match.seats;
  if (!owner || !guest) throw new Error("Expected two seats");
  return {
    a: await join(server, match.matchId, owner),
    b: await join(server, match.matchId, guest),
  };
}

/** Sends a hello that must fail; returns the fatal error after checking the close. */
async function refusedHello(hello: unknown) {
  const client = await TestClient.open(server.url);
  client.send(hello);
  const error = await client.take("error");
  expect(error.fatal).toBe(true);
  expect(await client.closedPromise).toBeGreaterThanOrEqual(1000);
  expect(client.peek("welcome")).toEqual([]);
  saw(error);
  return error;
}

const hello = (matchId: string, auth: { kind: string; token: string }) => ({
  t: "hello",
  protocol: 1,
  matchId,
  auth,
});

describe("hello handshake errors", () => {
  it("rejects unsupported protocols, malformed messages and bad credentials", async () => {
    const match = await signal();
    const [owner, guest] = match.seats;
    if (!owner || !guest) throw new Error("Expected two seats");
    expect(await refusedHello({ ...hello(match.matchId, owner), protocol: 2 })).toMatchObject({
      code: "PROTOCOL_VERSION",
    });
    expect(await refusedHello({ t: "ping", ts: 1 })).toMatchObject({ code: "BAD_MESSAGE" });
    expect(await refusedHello("not json")).toMatchObject({ code: "BAD_MESSAGE" });
    expect(
      await refusedHello(hello(match.matchId, { kind: "user", token: "not-a-token" })),
    ).toMatchObject({ code: "UNAUTHORIZED" });
    // A guest token presented as a user token is not a user.
    expect(await refusedHello(hello(match.matchId, { ...guest, kind: "user" }))).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses unknown matches, outsiders and matches that are not active", async () => {
    const match = await signal();
    const other = await signal();
    const [owner] = match.seats;
    const [, otherGuest] = other.seats;
    if (!owner || !otherGuest) throw new Error("Expected seats");
    for (const id of ["0190a0b0-0000-7000-8000-000000000000", "not-a-uuid"]) {
      expect(await refusedHello(hello(id, owner))).toMatchObject({ code: "MATCH_NOT_FOUND" });
    }
    // A guest of another match, and a signed-in user without a seat here.
    expect(await refusedHello(hello(match.matchId, otherGuest))).toMatchObject({
      code: "FORBIDDEN",
    });
    const outsider = await env.issuer.token({ sub: uniqueSlug("outsider"), name: "Outsider" });
    expect(
      await refusedHello(hello(match.matchId, { kind: "user", token: outsider })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await refusedHello(hello(match.matchId, { kind: "user", token: other.owner })),
    ).toMatchObject({ code: "FORBIDDEN" });
    const lobby = await signal(2, { start: false });
    const [lobbyOwner] = lobby.seats;
    if (!lobbyOwner) throw new Error("Expected a seat");
    expect(await refusedHello(hello(lobby.matchId, lobbyOwner))).toMatchObject({
      code: "MATCH_NOT_ACTIVE",
    });
  });

  it("reports a stored snapshot that fails its hash check as INTERNAL without details", async () => {
    const match = await signal();
    const [owner] = match.seats;
    if (!owner) throw new Error("Expected a seat");
    const first = await join(server, match.matchId, owner);
    await first.client.close();
    // Wait for the idle room to close, then corrupt the stored seq 0 snapshot hash.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await env.connection.db
      .update(matchSnapshots)
      .set({ stateHash: "0".repeat(64) })
      .where(eq(matchSnapshots.matchId, match.matchId));
    const error = await refusedHello(hello(match.matchId, owner));
    expect(error).toEqual({
      t: "error",
      code: "INTERNAL",
      message: "Internal server error",
      fatal: true,
    });
  });
});

describe("moves", () => {
  it("returns every rules rejection to the mover only and keeps the match running", async () => {
    const match = await signal();
    const { a, b } = await seated(match);
    let clientSeq = 0;
    const tryMove = async (client: TestClient, intent: unknown) => {
      const seq = clientSeq++;
      client.send({ t: "move", clientSeq: seq, intent });
      const rejected = await client.take("rejected", (message) => message.clientSeq === seq);
      saw(rejected);
      return rejected;
    };
    expect(await tryMove(b.client, { move: "step", args: { n: 1 } })).toMatchObject({
      code: "NOT_YOUR_TURN",
    });
    expect(await tryMove(a.client, { move: "fly" })).toMatchObject({ code: "UNKNOWN_MOVE" });
    expect(await tryMove(a.client, { move: "back" })).toMatchObject({ code: "MOVE_NOT_ALLOWED" });
    expect(await tryMove(a.client, { move: "step", args: { n: "x" } })).toMatchObject({
      code: "INVALID_ARGS",
    });
    expect(await tryMove(a.client, { move: "step", args: { n: 3 } })).toEqual({
      t: "rejected",
      clientSeq: clientSeq - 1,
      code: "INVALID_MOVE",
      gameCode: "TOO_FAR",
      message: "Three is too far",
    });
    const started = performance.now();
    expect(await tryMove(a.client, { move: "spin" })).toEqual({
      t: "rejected",
      clientSeq: clientSeq - 1,
      code: "GAME_ERROR",
      message: "Game execution failed",
    });
    expect(performance.now() - started).toBeLessThan(1500);
    // A non-increasing clientSeq is refused before it reaches the rules.
    a.client.send({ t: "move", clientSeq: 0, intent: { move: "step", args: { n: 1 } } });
    saw(await a.client.take("rejected", (message) => message.code === "BAD_MESSAGE"));

    // Nothing was applied; the next legal move is event 1 for both seats.
    const trackers = [new ViewTracker(a.welcome), new ViewTracker(b.welcome)];
    a.client.send({ t: "move", clientSeq: clientSeq++, intent: { move: "step", args: { n: 1 } } });
    trackers[0]?.apply(await nextUpdate(a.client, 1));
    trackers[1]?.apply(await nextUpdate(b.client, 1));
    expect(trackers.map((tracker) => tracker.view.game)).toMatchObject([
      { count: 1 },
      { count: 1 },
    ]);
    expect(b.client.peek("rejected")).toEqual([]);

    b.client.send({ t: "move", clientSeq: clientSeq++, intent: { move: "finish" } });
    trackers[0]?.apply(await nextUpdate(a.client, 2));
    expect(trackers[0]?.view.result).toEqual({ winners: ["1"], reason: "finished" });
    for (const client of [a.client, b.client]) {
      expect((await client.take("ended")).result).toEqual({ winners: ["1"], reason: "finished" });
    }
    b.client.send({ t: "move", clientSeq: clientSeq++, intent: { move: "step", args: { n: 1 } } });
    saw(await b.client.take("rejected", (message) => message.code === "MATCH_FINISHED"));
    const [row] = await env.connection.db
      .select({ status: matches.status, result: matches.result, lastSeq: matches.lastSeq })
      .from(matches)
      .where(eq(matches.id, match.matchId));
    expect(row).toEqual({
      status: "finished",
      result: { winners: ["1"], reason: "finished" },
      lastSeq: 2,
    });
    // Reconnecting to a finished match is refused; the replay endpoint serves it instead.
    const [owner] = match.seats;
    if (!owner) throw new Error("Expected a seat");
    expect(await refusedHello(hello(match.matchId, owner))).toMatchObject({
      code: "MATCH_NOT_ACTIVE",
    });
  });

  it("drops malformed and binary frames after hello without closing", async () => {
    const match = await signal();
    const { a } = await seated(match);
    a.client.send("{");
    saw(await a.client.take("error", (m) => m.code === "BAD_MESSAGE" && !m.fatal));
    a.client.send({ t: "teleport" });
    saw(await a.client.take("error", (m) => m.code === "BAD_MESSAGE" && !m.fatal));
    a.client.sendBinary(new Uint8Array([1, 2, 3]));
    saw(await a.client.take("error", (m) => m.code === "BAD_MESSAGE" && !m.fatal));
    a.client.send({ t: "chat", text: "" });
    await a.client.take("error", (m) => m.code === "BAD_MESSAGE");
    a.client.send(hello(match.matchId, match.seats[0] ?? { kind: "user", token: "" }));
    await a.client.take("error", (m) => m.code === "BAD_MESSAGE" && !m.fatal);
    a.client.send({ t: "ping", ts: 42 });
    expect(await a.client.take("pong")).toEqual({ t: "pong", ts: 42 });
    expect(a.client.closeCode).toBeNull();
  });

  it("stores snapshots at seq 0, every 50 events and at the end, and rebuilds from the latest", async () => {
    const match = await signal(3);
    const clients = [];
    for (const auth of match.seats) clients.push((await join(server, match.matchId, auth)).client);
    const lastSent = clients.map(() => 0);
    for (let seq = 0; seq < 120; seq++) {
      const turn = seq % clients.length;
      // Stay under the ten moves per second limit of each connection.
      const wait = (lastSent[turn] ?? 0) + 110 - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastSent[turn] = performance.now();
      clients[turn]?.send({
        t: "move",
        clientSeq: seq,
        intent: { move: "step", args: { n: 1 } },
      });
      for (const client of clients) await nextUpdate(client, seq + 1);
    }
    const snapshots = () =>
      env.connection.db
        .select({ seq: matchSnapshots.seq, state: matchSnapshots.state })
        .from(matchSnapshots)
        .where(eq(matchSnapshots.matchId, match.matchId))
        .orderBy(asc(matchSnapshots.seq));
    expect((await snapshots()).map((row) => row.seq)).toEqual([0, 50, 100]);
    const at100 = (await snapshots()).at(-1)?.state as MatchState;
    expect(at100.ctx.moveNumber).toBe(100);

    // A fresh server rebuilds from the seq 100 snapshot plus events 101..120.
    const restarted = await env.startServer();
    try {
      const [owner] = match.seats;
      if (!owner) throw new Error("Expected a seat");
      const again = await join(restarted, match.matchId, owner, 120);
      expect(again.welcome.seq).toBe(120);
      expect(again.welcome.view.game).toMatchObject({ count: 120 });
      for (const client of clients) expect(client.peek("error")).toEqual([]);
      again.client.send({ t: "move", clientSeq: 0, intent: { move: "finish" } });
      expect(await nextUpdate(again.client, 121)).toMatchObject({ seq: 121 });
      expect((await snapshots()).map((row) => row.seq)).toEqual([0, 50, 100, 121]);
    } finally {
      await restarted.close();
    }
  }, 60_000);
});

describe("presence, chat, ephemeral relay and limits", () => {
  it("relays chat with names and times, and limits chat to one per second", async () => {
    const match = await signal();
    const { a, b } = await seated(match);
    b.client.send({ t: "chat", text: "hello there" });
    for (const client of [a.client, b.client]) {
      const chat = await client.take("chat");
      expect(chat).toMatchObject({ from: "1", name: "Guest 1", text: "hello there" });
      expect(Number.isNaN(Date.parse(chat.at))).toBe(false);
    }
    b.client.send({ t: "chat", text: "too soon" });
    const limited = await b.client.take("error");
    expect(limited).toMatchObject({ code: "RATE_LIMITED", fatal: false });
    saw(limited);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.client.peek("chat")).toEqual([]);
  });

  it("limits moves to ten per second per connection", async () => {
    const match = await signal();
    const { a } = await seated(match);
    for (let clientSeq = 0; clientSeq < 11; clientSeq++) {
      a.client.send({ t: "move", clientSeq, intent: { move: "fly" } });
    }
    expect(await a.client.take("error")).toMatchObject({ code: "RATE_LIMITED", fatal: false });
    for (let index = 0; index < 10; index++) await a.client.take("rejected");
  });

  it("relays pointers and drags to other seats, hiding item IDs they cannot see", async () => {
    const match = await signal();
    const { a, b } = await seated(match);
    const secret = (a.welcome.view.game as { mine: string }).mine;
    a.client.send({ t: "ephemeral", data: { kind: "drag", item: secret, pos_mm: [10, -5] } });
    expect(await b.client.take("ephemeral")).toEqual({
      t: "ephemeral",
      from: "0",
      data: { kind: "pointer", pos_mm: [10, -5] },
    });
    a.client.send({ t: "ephemeral", data: { kind: "drag", item: "count", pos_mm: [1, 2] } });
    expect((await b.client.take("ephemeral")).data).toEqual({
      kind: "drag",
      item: "count",
      pos_mm: [1, 2],
    });
    b.client.send({ t: "ephemeral", data: { kind: "pointer", pos_mm: [0, 0] } });
    expect((await a.client.take("ephemeral")).from).toBe("1");
    expect(a.client.peek("ephemeral")).toEqual([]);
    expect(b.client.peek("ephemeral")).toEqual([]);
    expect(b.client.frames.join("")).not.toContain(secret);
    for (let index = 0; index < 25; index++) {
      a.client.send({ t: "ephemeral", data: { kind: "pointer", pos_mm: [index, 0] } });
    }
    expect(await a.client.take("error")).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("hands a seat to its newest connection and closes the old one", async () => {
    const match = await signal();
    const { a, b } = await seated(match);
    const [owner] = match.seats;
    if (!owner) throw new Error("Expected a seat");
    const replacement = await join(server, match.matchId, owner);
    const error = await a.client.take("error");
    expect(error).toMatchObject({ code: "SEAT_TAKEN_OVER", fatal: true });
    saw(error);
    expect(await a.client.closedPromise).toBe(1008);
    expect(replacement.welcome.match.seats.map((seat) => seat.connected)).toEqual([true, true]);
    replacement.client.send({ t: "move", clientSeq: 0, intent: { move: "step", args: { n: 2 } } });
    expect(await nextUpdate(b.client, 1)).toMatchObject({ t: "patch" });
    // The seat stays connected throughout, so the other seat never saw it leave.
    expect(b.client.peek("presence").every((p) => p.seats.every((s) => s.connected))).toBe(true);
  });

  it("closes live connections with MATCH_NOT_ACTIVE when the owner abandons the match", async () => {
    const match = await signal();
    const { a, b } = await seated(match);
    const response = await server.call("POST", `/api/matches/${match.matchId}/abandon`, {
      token: match.owner,
      body: {},
    });
    expect(response.statusCode).toBe(200);
    for (const client of [a.client, b.client]) {
      const error = await client.take("error");
      expect(error).toMatchObject({ code: "MATCH_NOT_ACTIVE", fatal: true });
      saw(error);
      await client.closedPromise;
    }
  });
});

describe("error code coverage", () => {
  it("produces the HTTP-only codes through the API", async () => {
    const match = await signal();
    const [row] = await env.connection.db
      .select({ versionId: matches.versionId })
      .from(matches)
      .where(eq(matches.id, match.matchId));
    const responses = [
      await server.call("GET", "/api/nowhere", { token: match.owner }),
      await server.call("POST", `/api/matches/${match.matchId}/start`, {
        token: match.owner,
        body: {},
      }),
      await server.call("POST", "/api/matches", {
        token: match.owner,
        body: { versionId: row?.versionId, seatCount: 4, options: {} },
      }),
    ];
    const codes = responses.map((response) => HttpErrorSchema.parse(response.json()).error);
    expect(codes.map((error) => error.code)).toEqual([
      "NOT_FOUND",
      "CONFLICT",
      "VALIDATION_FAILED",
    ]);
    for (const error of codes) saw(error);
  });

  it("has produced every protocol error code in this file", () => {
    expect([...produced].sort()).toEqual([...ErrorCodeSchema.options].sort());
  });
});
