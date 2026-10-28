import { describe, expect, it } from "vitest";
import { HostBuildSchema, HostRequestSchema, HostResponseSchema } from "./rules-host.js";

describe("privileged rules-host contract", () => {
  it("validates the version and strict command shapes", () => {
    expect(HostRequestSchema.safeParse({ v: 1, id: 1, command: { op: "prepare" } }).success).toBe(
      true,
    );
    expect(
      HostRequestSchema.safeParse({ v: 1, id: 1, command: { op: "prepare", source: "hidden" } })
        .success,
    ).toBe(false);
    const request = { v: 1, id: 1, command: { op: "apply", seat: "0", intent: { move: "tick" } } };
    expect(HostRequestSchema.safeParse(request).success).toBe(true);
    for (const value of [
      { ...request, v: 2 },
      { ...request, id: 0 },
      { ...request, command: { op: "eval", source: "process.exit()" } },
      { ...request, command: { ...request.command, secret: "hidden" } },
      { ...request, command: { ...request.command, intent: { move: "tick", args: 0.5 } } },
      { ...request, command: { op: "load", source: "", timeoutMs: 1001, memoryLimitBytes: 1 } },
    ])
      expect(HostRequestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only sanitized errors and state-free move successes", () => {
    const response = {
      v: 1,
      id: 1,
      ok: false,
      code: "GAME_ERROR",
      message: "Game execution failed",
    };
    expect(HostResponseSchema.safeParse(response).success).toBe(true);
    expect(HostResponseSchema.safeParse({ ...response, message: "secret" }).success).toBe(false);
    expect(HostResponseSchema.safeParse({ ...response, stack: "secret" }).success).toBe(false);
    const event = { seq: 1, seat: "0", intent: { move: "tick" } };
    expect(
      HostResponseSchema.safeParse({ v: 1, id: 1, ok: true, value: { ok: true, event } }).success,
    ).toBe(true);
    expect(
      HostResponseSchema.safeParse({ v: 1, id: 1, ok: true, value: { ok: true, event, state: {} } })
        .success,
    ).toBe(false);
  });

  it("rejects unsafe bundle paths and non-digests", () => {
    expect(HostBuildSchema.safeParse({ entry: "../game.js", files: {}, source: "" }).success).toBe(
      false,
    );
    expect(
      HostBuildSchema.safeParse({ entry: "game.js", files: { "game.js": "bad" }, source: "" })
        .success,
    ).toBe(false);
  });
});
