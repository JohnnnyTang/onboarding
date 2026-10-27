import { type MatchState, type Random, Uint32Schema } from "@bgp/schema";

export type RandomState = MatchState["rng"];
const UINT32_RANGE = 0x1_0000_0000;
const UINT53_RANGE = 0x20_0000_0000_0000;

/** One sfc32 step. All arithmetic in the generator is explicitly uint32. */
export function nextUint32(state: RandomState): number {
  const [a, b, c, d] = state;
  const sum = (a + b + d) >>> 0;
  state[0] = (b ^ (b >>> 9)) >>> 0;
  state[1] = (c + (c << 3)) >>> 0;
  state[2] = (((c << 21) | (c >>> 11)) + sum) >>> 0;
  state[3] = (d + 1) >>> 0;
  return sum;
}

function mix(value: number): number {
  let word = value >>> 0;
  word = Math.imul(word ^ (word >>> 16), 0x21f0aaad);
  word = Math.imul(word ^ (word >>> 15), 0x735a2d97);
  return (word ^ (word >>> 15)) >>> 0;
}

/** Fixed seed expansion and twelve warm-up steps are part of replay compatibility. */
export function seedRandom(seed: number): RandomState {
  Uint32Schema.parse(seed);
  const state: RandomState = [
    mix(seed + 0x9e3779b9),
    mix(seed + 0x3c6ef372),
    mix(seed + 0xdaa66d2b),
    1,
  ];
  for (let step = 0; step < 12; step += 1) nextUint32(state);
  return state;
}

/** The caller owns the mutable words; moves pass draft words for automatic rollback. */
export function createRandom(state: RandomState): Random {
  function int(min: number, max: number): number {
    const span = max - min + 1;
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min > max ||
      !Number.isSafeInteger(span)
    ) {
      throw new Error("Random bounds must be safe integers with a safe positive span");
    }
    const range = span <= UINT32_RANGE ? UINT32_RANGE : UINT53_RANGE;
    const limit = range - (range % span);
    let word: number;
    do {
      word = nextUint32(state);
      if (range === UINT53_RANGE) word = (word & 0x1f_ffff) * UINT32_RANGE + nextUint32(state);
    } while (word >= limit);
    return min + (word % span);
  }
  return {
    int,
    die: (sides) => int(1, sides),
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("Cannot pick from an empty array");
      return items[int(0, items.length - 1)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const shuffled = [...items];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = int(0, index);
        const item = shuffled[index] as T;
        shuffled[index] = shuffled[other] as T;
        shuffled[other] = item;
      }
      return shuffled;
    },
    id: () =>
      `i${Array.from({ length: 4 }, () => nextUint32(state).toString(16).padStart(8, "0")).join("")}`,
  };
}
