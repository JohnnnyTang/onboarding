import { describe, expect, test } from "vitest";
import {
  createInviteStore,
  inviteToken,
  MATCH_INVITES_KEY,
  MAX_STORED_INVITES,
} from "./match-invites";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

const entry = (matchId: string) => ({
  matchId,
  invites: [{ seat: "0", url: `http://web.test/join/${matchId}-token` }],
});

describe("invite store", () => {
  test("keeps a created match's links across a reload of the tab", () => {
    const storage = memoryStorage();
    createInviteStore(storage).set(entry("m1"));
    expect(createInviteStore(storage).get("m1")).toEqual(entry("m1"));
    expect(createInviteStore(storage).get("m2")).toBeUndefined();
  });

  test("ignores unreadable entries and drops the oldest beyond the limit", () => {
    const storage = memoryStorage();
    storage.setItem(MATCH_INVITES_KEY, JSON.stringify([{ matchId: 1 }, entry("ok")]));
    const store = createInviteStore(storage);
    expect(store.get("ok")).toEqual(entry("ok"));
    for (let n = 0; n < MAX_STORED_INVITES; n += 1) store.set(entry(`m${n}`));
    expect(store.get("ok")).toBeUndefined();
    expect(store.get(`m${MAX_STORED_INVITES - 1}`)).toBeDefined();
    storage.setItem(MATCH_INVITES_KEY, "{not json");
    expect(createInviteStore(storage).get("m1")).toBeUndefined();
  });

  test("reads the token of a join link", () => {
    expect(inviteToken("http://localhost:5173/join/AbC_d-1")).toBe("AbC_d-1");
    expect(inviteToken("http://localhost:5173/matches/x")).toBeNull();
    expect(inviteToken("not a url")).toBeNull();
  });
});
