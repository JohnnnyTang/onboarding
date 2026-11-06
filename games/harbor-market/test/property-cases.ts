import fc from "fast-check";

const seed = fc.integer({ min: 0, max: 0xffff_ffff });
export const harborCases = fc.tuple(seed, seed, fc.integer({ min: 2, max: 4 }), fc.boolean());
export const HARBOR_PROPERTY_SEED = 606;

export function harborInit(seed: number, count: number, shortGame: boolean) {
  return {
    seats: Array.from({ length: count }, (_, i) => String(i)),
    seed,
    options: { shortGame },
  };
}

export function sampleHarborCases(numRuns: number) {
  return fc.sample(harborCases, { numRuns, seed: HARBOR_PROPERTY_SEED });
}
