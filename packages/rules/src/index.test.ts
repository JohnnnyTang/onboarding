import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  countHidden,
  createRandom,
  defineGame,
  hashState,
  invalid,
  type MatchState,
  nextUint32,
  rekey,
  seatsAfter,
  seedRandom,
} from "./index.js";

describe("integer sfc32 and Random", () => {
  test("matches sfc32 reference steps including uint32 overflow", () => {
    const words: MatchState["rng"] = [1, 2, 3, 4];
    expect(nextUint32(words)).toBe(7);
    expect(words).toEqual([2, 27, 6291463, 5]);
    expect(nextUint32(words)).toBe(34);
    expect(nextUint32([0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff])).toBe(0xffff_fffd);
  });

  test("seed expansion and all operations are reproducible", () => {
    const run = (seed: number) => {
      const words = seedRandom(seed);
      const random = createRandom(words);
      return [
        random.int(-100, 100),
        random.die(6),
        random.pick(["a", "b"]),
        random.shuffle([1, 2, 3, 4]),
        random.id(),
        words,
      ];
    };
    expect(run(0)).toEqual(run(0));
    expect(run(0)).not.toEqual(run(1));
    expect(() => seedRandom(-1)).toThrow();
    expect(() => seedRandom(0x1_0000_0000)).toThrow();
  });

  test("rejection sampling discards the biased tail", () => {
    const words: MatchState["rng"] = [0, 0, 0, 0xffff_ffff];
    expect(createRandom(words).int(0, 2)).toBe(0);
    expect(words[3]).toBe(1); // Two draws, rather than biased modulo of the first.
  });

  test("supports inclusive signed, uint32 and wide safe integer ranges", () => {
    const random = createRandom(seedRandom(123));
    expect(random.int(9, 9)).toBe(9);
    for (let index = 0; index < 1000; index += 1) {
      for (const [min, max] of [
        [-9, 9],
        [0, 0xffff_ffff],
        [-Number.MAX_SAFE_INTEGER, -1],
        [1, Number.MAX_SAFE_INTEGER],
      ] as const) {
        const value = random.int(min, max);
        expect(Number.isSafeInteger(value) && value >= min && value <= max).toBe(true);
      }
    }
    for (const bounds of [
      [2, 1],
      [0.1, 2],
      [0, Infinity],
      [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(() => random.int(bounds[0], bounds[1])).toThrow();
    }
    expect(() => random.die(0)).toThrow();
    expect(() => random.pick([])).toThrow();
  });

  test("shuffle is a copy, preserves contents and covers permutations", () => {
    const input = Object.freeze([0, 1, 2]);
    const random = createRandom(seedRandom(123));
    const permutations = new Set<string>();
    for (let run = 0; run < 100; run += 1) {
      const shuffled = random.shuffle(input);
      expect(shuffled).not.toBe(input);
      expect([...shuffled].sort()).toEqual(input);
      permutations.add(shuffled.join());
    }
    expect(permutations.size).toBe(6);
    expect(random.shuffle([])).toEqual([]);
    expect(random.shuffle([7])).toEqual([7]);
    expect(random.pick([7])).toBe(7);
  });

  test("IDs are opaque and do not repeat in a match", () => {
    const random = createRandom(seedRandom(123));
    const ids = Array.from({ length: 10000 }, () => random.id());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^i[a-f0-9]{32}$/.test(id))).toBe(true);
  });
});

describe("canonical JSON and SHA-256", () => {
  test("sorts all keys lexically, preserves array order and arbitrary keys", () => {
    const value = JSON.parse(
      '{"2":2,"10":10,"__proto__":{"z":1,"a":2},"a":[null,true,"雪\\n",-0]}',
    );
    expect(canonicalJson(value)).toBe(
      '{"10":10,"2":2,"__proto__":{"a":2,"z":1},"a":[null,true,"雪\\n",0]}',
    );
    expect(canonicalJson({ z: 1, a: { b: 2, a: 3 } })).toBe(
      canonicalJson({ a: { a: 3, b: 2 }, z: 1 }),
    );
    expect(() => canonicalJson({ float: 0.5 })).toThrow();
  });

  test("hashes canonical UTF-8 bytes using the standard SHA-256 vector", async () => {
    // The hash helper accepts MatchState, while this cast tests a known canonical payload.
    expect(await hashState({} as MatchState)).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });
});

describe("SDK helpers", () => {
  test("invalid validates game codes and defineGame preserves identity", () => {
    expect(invalid("NO_CARDS", "Empty")).toEqual({
      invalid: true,
      code: "NO_CARDS",
      message: "Empty",
    });
    expect(() => invalid("bad-code", "No")).toThrow();
    // Generic identity remains usable without executing any game callbacks.
    const def = {
      sdk: 1,
      setup: () => null,
      moves: {},
      playerView: () => null,
      present: () => {
        throw new Error("unused");
      },
    } as const;
    expect(defineGame(def)).toBe(def);
  });

  test("rekey copies instances and countHidden exposes only length", () => {
    const items = [
      { id: "old", secret: "fish" },
      { id: "older", secret: "wood" },
    ];
    const keyed = rekey(items, createRandom(seedRandom(1)));
    expect(keyed.map((item) => item.secret)).toEqual(["fish", "wood"]);
    expect(keyed.every((item) => !items.some((old) => old.id === item.id))).toBe(true);
    expect(items[0]?.id).toBe("old");
    expect(countHidden(items)).toBe(2);
    expect(countHidden([])).toBe(0);
  });

  test("seatsAfter wraps and excludes the starting seat", () => {
    expect(seatsAfter(["0", "1", "2"], "1")).toEqual(["2", "0"]);
    expect(seatsAfter(["0"], "0")).toEqual([]);
    expect(() => seatsAfter(["0"], "1")).toThrow();
  });
});
