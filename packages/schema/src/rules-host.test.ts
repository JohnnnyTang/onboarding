import { describe, expect, it } from "vitest";
import {
  HostBuildSchema,
  HostMoveOutcomeSchema,
  HostRequestSchema,
  HostResponseSchema,
} from "./rules-host.js";

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
    expect(
      HostMoveOutcomeSchema.safeParse({ ok: false, code: "GAME_ERROR", message: "hidden" }).success,
    ).toBe(false);
    expect(
      HostMoveOutcomeSchema.safeParse({
        ok: false,
        code: "GAME_ERROR",
        message: "Game execution failed",
        gameCode: "HIDDEN",
      }).success,
    ).toBe(false);
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

describe("sandbox builds and loadSandbox (T17)", () => {
  const files = { "components.json": "a".repeat(64) };
  const components = {
    schemaVersion: 1,
    defs: [],
    zones: [],
    setup: { instances: [] },
  };

  it("accepts a sandbox build naming its components file", () => {
    expect(
      HostBuildSchema.safeParse({
        mode: "sandbox",
        components: "components.json",
        files,
        source: "{}",
      }).success,
    ).toBe(true);
    // A sandbox build has no entry, and an enforced build no components path.
    expect(
      HostBuildSchema.safeParse({ mode: "sandbox", entry: "components.json", files, source: "{}" })
        .success,
    ).toBe(false);
    expect(
      HostBuildSchema.safeParse({ mode: "enforced", entry: "game.js", files, source: "" }).success,
    ).toBe(false);
  });

  it("validates the components carried by loadSandbox", () => {
    const command = { op: "loadSandbox", components, timeoutMs: 1000, memoryLimitBytes: 1024 };
    expect(HostRequestSchema.safeParse({ v: 1, id: 1, command }).success).toBe(true);
    expect(
      HostRequestSchema.safeParse({
        v: 1,
        id: 1,
        command: { ...command, components: { ...components, schemaVersion: 2 } },
      }).success,
    ).toBe(false);
    expect(
      HostRequestSchema.safeParse({ v: 1, id: 1, command: { ...command, source: "x" } }).success,
    ).toBe(false);
  });
});
