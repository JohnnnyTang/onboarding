import type { ClientView } from "@bgp/schema";
import jsonpatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/room/rate-limit.js";
import { diffViews, LARGE_PATCH_BYTES, viewStrings, viewUpdate } from "../src/room/view-diff.js";

const ctx = {
  seats: ["0", "1"],
  currentSeat: "0",
  activeSeats: ["0"],
  phase: "main",
  turn: 1,
  moveNumber: 0,
  options: {},
};
const view = (game: ClientView["game"]): ClientView => ({ ctx, game, result: null });

describe("view diffs", () => {
  it("produces RFC 6902 operations that turn the previous view into the next one", () => {
    const before = view({ hand: [{ id: "a" }, { id: "b" }], deck: 3, "a/b~c": 1 });
    const after = view({ hand: [{ id: "b" }], deck: 2, "a/b~c": 2, extra: null });
    const ops = diffViews(before, after);
    expect(ops.some((op) => op.path === "/game/a~1b~0c")).toBe(true);
    const applied = jsonpatch.applyPatch(
      structuredClone(before),
      ops as jsonpatch.Operation[],
      true,
      false,
    ).newDocument;
    expect(applied).toEqual(after);
    // Removals carry no values, so nothing from the previous view is repeated.
    expect(JSON.stringify(ops)).not.toContain('"a"');
  });

  it("sends a patch, or a snapshot only for a large change bigger than the view", () => {
    const small = viewUpdate(view({ n: 1 }), view({ n: 2, s: "x".repeat(50) }));
    expect(small.kind).toBe("patch");
    const items = (prefix: string) =>
      Array.from({ length: 400 }, (_, i) => ({ id: `${prefix}${i}`, v: i }));
    const large = viewUpdate(view({ items: items("a") }), view({ items: items("b") }));
    expect(large.kind).toBe("snapshot");
    expect(
      JSON.stringify(diffViews(view({ items: items("a") }), view({ items: items("b") }))).length,
    ).toBeGreaterThan(LARGE_PATCH_BYTES);
    expect(viewUpdate(null, view({})).kind).toBe("snapshot");
  });

  it("collects every string and key a view contains", () => {
    expect([...viewStrings(view({ hand: [{ id: "c1" }], n: 3 }))]).toEqual(
      expect.arrayContaining(["hand", "id", "c1", "main", "0"]),
    );
  });
});

describe("rate limiter", () => {
  it("accepts at most the limit in any one-second window", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect([limiter.allow(), limiter.allow(), limiter.allow()]).toEqual([true, true, false]);
    now = 999;
    expect(limiter.allow()).toBe(false);
    // Both calls at 0 leave the window together.
    now = 1000;
    expect([limiter.allow(), limiter.allow(), limiter.allow()]).toEqual([true, true, false]);
  });
});
