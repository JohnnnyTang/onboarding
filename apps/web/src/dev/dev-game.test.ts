import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DevServerError,
  devAssetUrl,
  devServerOrigin,
  fetchDevGame,
  loadDevMatch,
  saveDevMatch,
} from "./dev-game";

const GAME = {
  protocol: 1,
  buildId: 2,
  manifest: {
    schemaVersion: 1,
    id: "my-game",
    name: "My Game",
    version: "0.1.0",
    mode: "enforced",
    sdk: 1,
    players: { min: 2, max: 4 },
    entry: "dist/game.js",
    components: "components.json",
  },
  components: { schemaVersion: 1, defs: [] },
  source: "export default {};",
  errors: [],
};

function respond(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("devServerOrigin", () => {
  it.each([
    ["http://127.0.0.1:4400", "http://127.0.0.1:4400"],
    ["http://localhost:4400/", "http://localhost:4400"],
    ["http://[::1]:4400", "http://[::1]:4400"],
  ])("accepts %s", (param, origin) => {
    expect(devServerOrigin(param)).toBe(origin);
  });

  it.each([
    null,
    "",
    "not a url",
    "https://127.0.0.1:4400",
    "http://example.com:4400",
    "http://127.0.0.1.example.com",
    "http://127.0.0.1:4400/game",
    "http://127.0.0.1:4400/?x=1",
    "http://user:pw@127.0.0.1:4400",
    "javascript:alert(1)",
  ])("refuses %s", (param) => {
    expect(devServerOrigin(param)).toBeNull();
  });
});

describe("fetchDevGame", () => {
  it("returns a validated build", async () => {
    const game = await fetchDevGame("http://127.0.0.1:4400", respond(GAME));
    expect(game.buildId).toBe(2);
  });

  it("explains an unreachable server and refuses malformed responses", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(fetchDevGame("http://127.0.0.1:4400", down)).rejects.toThrow(
      "Cannot reach bgp dev at http://127.0.0.1:4400. Is it running?",
    );
    await expect(
      fetchDevGame("http://127.0.0.1:4400", respond({ ...GAME, source: null })),
    ).rejects.toBeInstanceOf(DevServerError);
    await expect(fetchDevGame("http://127.0.0.1:4400", respond({}, 500))).rejects.toThrow(
      "bgp dev answered 500",
    );
  });
});

describe("dev matches", () => {
  it("round-trips a match through session storage and ignores bad records", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const match = {
      id: "0192f3a4-5b6c-7d8e-9f01-000000000001",
      projectId: "0192f3a4-5b6c-7d8e-9f01-000000000002",
      init: { seats: ["0", "1"], seed: 7, options: {} },
      events: [{ seq: 1, seat: "0", intent: { move: "play", args: { card: "i1" } } }],
      updatedAt: "2026-11-06T10:00:00.000Z",
    };
    await saveDevMatch(match, "my-game");
    expect(loadDevMatch("my-game")).toEqual(match);
    expect(loadDevMatch("other-game")).toBeNull();
    store.set("bgp.dev-match.my-game", "{");
    expect(loadDevMatch("my-game")).toBeNull();
  });

  it("builds asset URLs that change with each build", () => {
    expect(devAssetUrl("http://127.0.0.1:4400", "assets/card 1.png", 3)).toBe(
      "http://127.0.0.1:4400/assets/card%201.png?build=3",
    );
  });
});
