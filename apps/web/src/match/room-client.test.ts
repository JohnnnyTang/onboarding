import type { ClientView, ServerMessage } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { createRoomClient, type RoomAuth, type RoomSocket, reconnectDelay } from "./room-client";

class FakeSocket implements RoomSocket {
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: RoomSocket["onopen"] = null;
  onmessage: RoomSocket["onmessage"] = null;
  onclose: RoomSocket["onclose"] = null;
  onerror: RoomSocket["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: ServerMessage | string) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const HASH = "a".repeat(64);
const CTX = {
  seats: ["0", "1"],
  currentSeat: "0",
  activeSeats: ["0"],
  phase: "main",
  turn: 1,
  moveNumber: 0,
  options: {},
};
const view = (count: number): ClientView => ({ ctx: CTX, game: { count }, result: null });
const SEATS = [
  { seat: "0", name: "Ann", connected: true, guest: true },
  { seat: "1", name: "Bo", connected: false, guest: true },
];
const welcome = (seq: number, count = seq): ServerMessage => ({
  t: "welcome",
  protocol: 1,
  seat: "0",
  match: { id: "m1", status: "active", versionId: "v1", buildHash: HASH, seats: SEATS },
  seq,
  view: view(count),
});

function setup(auth: RoomAuth | null = { kind: "guest", token: "guest-token" }) {
  const sockets: FakeSocket[] = [];
  const timers: { callback: () => void; ms: number }[] = [];
  const client = createRoomClient({
    url: "ws://test/ws",
    matchId: "m1",
    auth: () => auth,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    random: () => 0,
  });
  const last = () => {
    const socket = sockets[sockets.length - 1];
    if (!socket) throw new Error("No socket");
    return socket;
  };
  return { client, sockets, timers, last };
}

describe("room client", () => {
  it("sends hello on open and takes the view from welcome", () => {
    const { client, last } = setup();
    client.connect();
    expect(client.getState().status).toBe("connecting");
    last().open();
    expect(last().sent).toEqual([
      { t: "hello", protocol: 1, matchId: "m1", auth: { kind: "guest", token: "guest-token" } },
    ]);
    last().receive(welcome(3));
    const state = client.getState();
    expect(state).toMatchObject({ status: "open", seat: "0", seq: 3, view: view(3) });
    expect(state.match?.seats).toEqual(SEATS);
  });

  it("applies consecutive patches and acknowledges its own move", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    last().receive(welcome(1));
    expect(client.move({ move: "draw" })).toBe(true);
    expect(last().sent[1]).toEqual({ t: "move", clientSeq: 0, intent: { move: "draw" } });
    expect(client.getState().movePending).toBe(true);
    last().receive({
      t: "patch",
      seq: 2,
      ops: [{ op: "replace", path: "/game/count", value: 2 }],
      cause: { seat: "0", clientSeq: 0, move: "draw" },
    });
    expect(client.getState()).toMatchObject({ seq: 2, view: view(2), movePending: false });
    expect(client.move({ move: "draw" })).toBe(true);
    expect(last().sent[2]).toMatchObject({ clientSeq: 1 });
  });

  it("asks for a resync on a sequence gap and ignores patches until the snapshot", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    last().receive(welcome(1));
    const patch = (seq: number, value: number): ServerMessage => ({
      t: "patch",
      seq,
      ops: [{ op: "replace", path: "/game/count", value }],
      cause: { seat: "1", move: "draw" },
    });
    last().receive(patch(3, 3));
    expect(last().sent).toContainEqual({ t: "resync" });
    last().receive(patch(4, 4));
    expect(client.getState()).toMatchObject({ seq: 1, view: view(1) });
    expect(
      last().sent.filter((message) => JSON.stringify(message).includes("resync")),
    ).toHaveLength(1);
    last().receive({ t: "snapshot", seq: 4, view: view(4) });
    last().receive(patch(5, 5));
    expect(client.getState()).toMatchObject({ seq: 5, view: view(5) });
  });

  it("asks for a resync when a patch does not apply", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    last().receive(welcome(1));
    last().receive({
      t: "patch",
      seq: 2,
      ops: [{ op: "remove", path: "/game/missing" }],
      cause: { seat: "1", move: "draw" },
    });
    expect(client.getState().seq).toBe(1);
    expect(last().sent).toContainEqual({ t: "resync" });
  });

  it("ignores frames that are not protocol messages", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    last().receive(welcome(1));
    last().receive("not json");
    last().receive(JSON.stringify({ t: "snapshot", seq: 9, view: { ctx: CTX, game: 1.5 } }));
    expect(client.getState()).toMatchObject({ seq: 1, view: view(1) });
  });

  it("keeps rejections, presence, chat and the result", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    last().receive(welcome(1));
    client.move({ move: "pass" });
    last().receive({
      t: "rejected",
      clientSeq: 0,
      code: "INVALID_MOVE",
      gameCode: "PASS_NOT_ALLOWED",
      message: "Another move is available.",
    });
    expect(client.getState().rejected).toEqual({
      id: 1,
      code: "INVALID_MOVE",
      gameCode: "PASS_NOT_ALLOWED",
      message: "Another move is available.",
    });
    expect(client.getState().movePending).toBe(false);
    const seats = SEATS.map((seat) => ({ ...seat, connected: true }));
    last().receive({ t: "presence", seats });
    expect(client.getState().match?.seats).toEqual(seats);
    last().receive({ t: "chat", from: "1", name: "Bo", text: "hi", at: "2026-11-03T10:00:00Z" });
    expect(client.getState().chat).toEqual([
      { id: 1, from: "1", name: "Bo", text: "hi", at: "2026-11-03T10:00:00Z" },
    ]);
    last().receive({ t: "ended", result: { winners: ["1"] } });
    expect(client.getState().result).toEqual({ winners: ["1"] });
  });

  it("reconnects with backoff and sends the last seq", () => {
    const { client, sockets, timers, last } = setup();
    client.connect();
    last().open();
    last().receive(welcome(4));
    last().drop(1001);
    expect(client.getState().status).toBe("reconnecting");
    expect(timers.map((timer) => timer.ms)).toEqual([250]);
    timers[0]?.callback();
    expect(sockets).toHaveLength(2);
    last().drop();
    expect(timers.map((timer) => timer.ms)).toEqual([250, 500]);
    timers[1]?.callback();
    last().open();
    expect(last().sent[0]).toMatchObject({ t: "hello", lastSeq: 4 });
    last().receive(welcome(6));
    expect(client.getState()).toMatchObject({ status: "open", seq: 6 });
    // A successful welcome resets the backoff.
    last().drop();
    expect(timers[2]?.ms).toBe(250);
  });

  it("stops after a fatal error that a new connection cannot fix", () => {
    const { client, sockets, timers, last } = setup();
    client.connect();
    last().open();
    last().receive({
      t: "error",
      code: "SEAT_TAKEN_OVER",
      message: "Another connection took this seat",
      fatal: true,
    });
    last().drop(1008);
    expect(client.getState()).toMatchObject({
      status: "closed",
      error: { code: "SEAT_TAKEN_OVER", fatal: true },
    });
    expect(timers).toHaveLength(0);
    client.connect();
    expect(sockets).toHaveLength(1);
  });

  it("reconnects after a fatal internal error", () => {
    const { client, timers, last } = setup();
    client.connect();
    last().open();
    last().receive({ t: "error", code: "INTERNAL", message: "Internal error", fatal: true });
    last().drop(1011);
    expect(client.getState().status).toBe("reconnecting");
    expect(timers).toHaveLength(1);
  });

  it("does not connect without credentials", () => {
    const { client, sockets } = setup(null);
    client.connect();
    expect(sockets).toHaveLength(0);
    expect(client.getState()).toMatchObject({ status: "closed", error: { code: "UNAUTHORIZED" } });
  });

  it("refuses moves while not connected and closes cleanly", () => {
    const { client, timers, last } = setup();
    client.connect();
    expect(client.move({ move: "draw" })).toBe(false);
    last().open();
    last().receive(welcome(1));
    client.close();
    expect(last().closedWith).toBe(1000);
    expect(client.getState().status).toBe("closed");
    expect(timers).toHaveLength(0);
  });

  it("adds jitter to the backoff and caps it", () => {
    expect(reconnectDelay(0, 0)).toBe(250);
    expect(reconnectDelay(0, 0.999)).toBe(499);
    expect(reconnectDelay(40, 0)).toBe(8000);
  });
});
