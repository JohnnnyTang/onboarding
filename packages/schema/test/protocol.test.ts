import { describe, expect, test } from "vitest";
import {
  ClientMessageSchema,
  ErrorCodeSchema,
  JsonPatchOperationSchema,
  ServerMessageSchema,
} from "../src/index.js";
import { match, seatInfo, state, view } from "./fixtures.js";

describe("WebSocket protocol", () => {
  test.each([
    { t: "hello", protocol: 1, matchId: "m1", auth: { kind: "guest", token: "token" }, lastSeq: 0 },
    { t: "move", clientSeq: 1, intent: { move: "draw", args: null } },
    { t: "resync" },
    { t: "ephemeral", data: { kind: "drag", item: "i1", pos_mm: [1, 2] } },
    { t: "ephemeral", data: { kind: "pointer", pos_mm: [1, 2] } },
    { t: "chat", text: "Hello" },
    { t: "ping", ts: 123 },
  ])("accepts client message %#", (value) => {
    expect(ClientMessageSchema.parse(value)).toEqual(value);
  });
  test.each([
    { t: "welcome", protocol: 1, seat: "0", match, seq: 0, view },
    {
      t: "patch",
      seq: 1,
      ops: [{ op: "replace", path: "/game/deckCount", value: 3 }],
      cause: { seat: "0", clientSeq: 1, move: "draw" },
    },
    { t: "snapshot", seq: 1, view },
    {
      t: "rejected",
      clientSeq: 1,
      code: "INVALID_MOVE",
      gameCode: "NO_CARDS",
      message: "No cards",
    },
    { t: "presence", seats: [seatInfo] },
    { t: "ephemeral", from: "0", data: { kind: "pointer", pos_mm: [0, 0] } },
    { t: "chat", from: "0", name: "Guest", text: "Hi", at: "2026-10-27T12:00:00Z" },
    { t: "ended", result: { winners: ["0"], scores: { "0": 10 } } },
    { t: "error", code: "INTERNAL", message: "Try again", fatal: true },
    { t: "pong", ts: 123 },
  ])("accepts server message %#", (value) => {
    expect(ServerMessageSchema.parse(value)).toEqual(value);
  });
  test.each([
    { t: "unknown" },
    { t: "hello", protocol: 2, matchId: "m", auth: { kind: "user", token: "t" } },
    { t: "move", clientSeq: 0.5, intent: { move: "draw" } },
    { t: "chat", text: "" },
    { t: "chat", text: "a".repeat(501) },
    { t: "resync", state },
    { t: "ephemeral", data: { kind: "pointer", pos_mm: [0.1, 0] } },
  ])("rejects invalid client message %#", (value) => {
    expect(ClientMessageSchema.safeParse(value).success).toBe(false);
  });
  test("rejects unknown error codes and extra private fields", () => {
    expect(ErrorCodeSchema.safeParse("NEW_ERROR").success).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        t: "error",
        code: "INTERNAL",
        message: "Oops",
        fatal: true,
        stack: "private",
      }).success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        t: "welcome",
        protocol: 1,
        seat: "0",
        match: { ...match, seed: 123 },
        seq: 0,
        view,
      }).success,
    ).toBe(false);
  });
  test.each([
    { op: "add", path: "/a~1b", value: 1 },
    { op: "remove", path: "/a" },
    { op: "replace", path: "", value: {} },
    { op: "move", path: "/a", from: "/b" },
    { op: "copy", path: "/a", from: "/b" },
    { op: "test", path: "/a", value: null },
  ])("accepts RFC 6902 operation %#", (value) => {
    expect(JsonPatchOperationSchema.parse(value)).toEqual(value);
  });
  test.each([
    { op: "add", path: "/a" },
    { op: "remove", path: "not-pointer" },
    { op: "copy", path: "/a" },
    { op: "remove", path: "/a~2" },
    { op: "replace", path: "/a", value: 0.5 },
    { op: "remove", path: "/a", value: "extra" },
  ])("rejects malformed JSON Patch %#", (value) => {
    expect(JsonPatchOperationSchema.safeParse(value).success).toBe(false);
  });
});
