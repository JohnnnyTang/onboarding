import { describe, expect, it } from "vitest";
import { validHostReply } from "../src/host-reply.js";

describe("operation-specific IPC replies", () => {
  it.each(["prepare", "load", "create", "restore", "dispose"] as const)(
    "requires a null acknowledgement for %s",
    (op) => {
      expect(validHostReply(op, null)).toBe(true);
      expect(validHostReply(op, "a".repeat(64))).toBe(false);
      expect(
        validHostReply(op, { ok: true, event: { seq: 1, seat: "0", intent: { move: "tick" } } }),
      ).toBe(false);
    },
  );

  it("rejects valid payloads delivered for the wrong operation", () => {
    expect(validHostReply("hash", "a".repeat(64))).toBe(true);
    expect(validHostReply("hash", null)).toBe(false);
    expect(validHostReply("apply", "a".repeat(64))).toBe(false);
    expect(validHostReply("views", { ok: true })).toBe(false);
    expect(validHostReply("exportState", {})).toBe(false);
  });
});
