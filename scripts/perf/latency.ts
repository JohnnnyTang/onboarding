/** Summary of move round-trip samples, in milliseconds rounded to 0.1. */
export interface LatencySummary {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Nearest-rank percentile of sorted samples (`p` in 0..100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("No samples");
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: round(sorted[0] ?? Number.NaN),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? Number.NaN),
    mean: round(total / sorted.length),
  };
}
