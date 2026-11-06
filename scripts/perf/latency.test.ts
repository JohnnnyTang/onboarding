import { describe, expect, test } from "vitest";
import { percentile, summarize } from "./latency.js";

describe("PERF-01 latency summary", () => {
  test("uses nearest-rank percentiles", () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
  });

  test("summarizes unsorted samples", () => {
    const summary = summarize([30, 10, 20, 40.04]);
    expect(summary).toEqual({
      count: 4,
      min: 10,
      p50: 20,
      p90: 40,
      p95: 40,
      p99: 40,
      max: 40,
      mean: 25,
    });
  });

  test("refuses an empty run", () => {
    expect(() => summarize([])).toThrow("No samples");
  });
});
