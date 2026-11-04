import { describe, expect, test } from "vitest";
import {
  CLAIMED_SEATS_KEY,
  createClaimedSeats,
  MAX_STORED_SEATS,
  type SeatStorage,
} from "./claimed-seats";

function memoryStorage(initial: Record<string, string> = {}): SeatStorage & {
  items: Record<string, string>;
} {
  const items = { ...initial };
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
    },
  };
}

const guest = { matchId: "m-1", seat: "0", displayName: "Tess", guestToken: "guest-1" };

describe("claimed seats", () => {
  test("survive a reload of the tab through session storage", () => {
    const storage = memoryStorage();
    createClaimedSeats(storage).set(guest);
    expect(createClaimedSeats(storage).get("m-1")).toEqual(guest);
    expect(createClaimedSeats(storage).get("m-2")).toBeUndefined();
  });

  test("stay in memory without storage", () => {
    const seats = createClaimedSeats();
    seats.set(guest);
    expect(seats.get("m-1")).toEqual(guest);
    expect(createClaimedSeats().get("m-1")).toBeUndefined();
  });

  test("ignore malformed or foreign stored data", () => {
    for (const value of ["not json", "{}", '[{"matchId":1}]', '[null, "x"]']) {
      const seats = createClaimedSeats(memoryStorage({ [CLAIMED_SEATS_KEY]: value }));
      expect(seats.get("m-1")).toBeUndefined();
    }
    const mixed = JSON.stringify([{ matchId: "m-0", seat: 1 }, guest]);
    expect(createClaimedSeats(memoryStorage({ [CLAIMED_SEATS_KEY]: mixed })).get("m-1")).toEqual(
      guest,
    );
  });

  test("store only seat fields and drop the oldest seats beyond the limit", () => {
    const storage = memoryStorage();
    const seats = createClaimedSeats(storage);
    seats.set({ ...guest, extra: "x" } as typeof guest);
    expect(storage.items[CLAIMED_SEATS_KEY]).not.toContain("extra");
    for (let i = 2; i <= MAX_STORED_SEATS + 1; i += 1) seats.set({ ...guest, matchId: `m-${i}` });
    const reloaded = createClaimedSeats(storage);
    expect(reloaded.get("m-1")).toBeUndefined();
    expect(reloaded.get(`m-${MAX_STORED_SEATS + 1}`)).toBeDefined();
  });

  test("keep working when storage throws", () => {
    const seats = createClaimedSeats({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    });
    seats.set(guest);
    expect(seats.get("m-1")).toEqual(guest);
  });
});
