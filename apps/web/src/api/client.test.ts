import { describe, expect, test } from "vitest";
import { ApiError, createApiClient, type TokenScope, UnexpectedResponseError } from "./client";

const HASH = "a".repeat(64);
const SUMMARY = {
  id: "match-1",
  status: "lobby",
  versionId: "version-1",
  buildHash: HASH,
  seats: [
    { seat: "0", name: "Tess", connected: false, guest: true },
    { seat: "1", name: "", connected: false, guest: false },
  ],
};

interface Recorded {
  url: string;
  init: RequestInit;
}

function harness(
  respond: (url: URL) => Response,
  tokenFor: (scope: TokenScope) => string | null = () => null,
) {
  const calls: Recorded[] = [];
  const scopes: TokenScope[] = [];
  const api = createApiClient({
    baseUrl: "http://api.test/",
    tokens: {
      tokenFor(scope) {
        scopes.push(scope);
        return tokenFor(scope);
      },
    },
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, init });
      return respond(url);
    },
  });
  return { api, calls, scopes };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headers = (call: Recorded | undefined) =>
  (call?.init.headers ?? {}) as Record<string, string>;

describe("API client", () => {
  test("lists games with the designer token, no cookies and a validated query", async () => {
    const { api, calls } = harness(
      () => json({ items: [], cursor: null }),
      () => "user-token",
    );
    await expect(api.listGames({ limit: 20 })).resolves.toEqual({ items: [], cursor: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/api/games?limit=20");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(headers(calls[0]).authorization).toBe("Bearer user-token");
    await expect(api.listGames({ limit: 500 })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("anonymous calls send no authorization header", async () => {
    const { api, calls } = harness(() => json({ matchId: "match-1", seat: "0", guestToken: "g" }));
    await api.claimInvite("tok/en", { displayName: "Tess" });
    expect(calls[0]?.url).toBe("http://api.test/api/invites/tok%2Fen/claim");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ displayName: "Tess" }));
    expect(headers(calls[0])["content-type"]).toBe("application/json");
    expect(headers(calls[0]).authorization).toBeUndefined();
  });

  test("validates request bodies before sending them", async () => {
    const { api, calls } = harness(() => json({}));
    await expect(api.claimInvite("token", { displayName: "" })).rejects.toThrow();
    await expect(
      api.claimInvite("token", { displayName: "Tess", extra: true } as never),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("match requests are scoped to the match so a guest token can be chosen", async () => {
    const { api, calls, scopes } = harness(
      () => json(SUMMARY),
      (scope) => (scope.matchId === "match-1" ? "guest-token" : "user-token"),
    );
    await expect(api.getMatch("match-1")).resolves.toEqual(SUMMARY);
    expect(scopes).toEqual([{ matchId: "match-1" }]);
    expect(headers(calls[0]).authorization).toBe("Bearer guest-token");
  });

  test("error envelopes become ApiError with the documented code", async () => {
    const { api } = harness(() =>
      json({ error: { code: "CONFLICT", message: "This seat is already taken" } }, 409),
    );
    const error = await api.claimInvite("token", { displayName: "Tess" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "This seat is already taken",
      errors: [],
    });
  });

  test("validation errors keep their paths", async () => {
    const errors = [{ path: "displayName", message: "Too long" }];
    const { api } = harness(() =>
      json({ error: { code: "BAD_MESSAGE", message: "Invalid", errors } }, 400),
    );
    await expect(api.claimInvite("token", { displayName: "Tess" })).rejects.toMatchObject({
      code: "BAD_MESSAGE",
      errors,
    });
  });

  test("responses that do not match the contract are rejected", async () => {
    // A summary must never carry the seed; strict schemas reject unknown fields.
    const leaky = harness(() => json({ ...SUMMARY, seed: 42 }));
    await expect(leaky.api.getMatch("match-1")).rejects.toBeInstanceOf(UnexpectedResponseError);
    const html = harness(() => new Response("<html>gateway</html>", { status: 502 }));
    const error = await html.api.listMatches().catch((e) => e);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.status).toBe(502);
    expect(String(error.message)).not.toContain("gateway");
  });

  test("path parameters are encoded", async () => {
    const { api, calls } = harness(() =>
      json({ id: "g", slug: "abc", name: "A", visibility: "private", versions: [] }),
    );
    await api.getGame("../matches");
    expect(calls[0]?.url).toBe("http://api.test/api/games/..%2Fmatches");
  });

  test("version reads and file downloads use the match scope and keep the bytes", async () => {
    const version = {
      id: "version-1",
      gameId: "game-1",
      manifest: {
        schemaVersion: 1,
        id: "harbor-market",
        name: "Harbor Market",
        version: "0.1.0",
        mode: "enforced",
        sdk: 1,
        players: { min: 2, max: 4 },
        entry: "dist/game.js",
        components: "components.json",
      },
      status: "ready",
      buildHash: HASH,
      validationErrors: null,
    };
    const { api, calls, scopes } = harness(
      (url) =>
        url.pathname.includes("/files/")
          ? new Response("export default 1;", { headers: { "content-type": "text/javascript" } })
          : json(version),
      (scope) => (scope.matchId === "match-1" ? "guest-token" : null),
    );
    await expect(api.getVersion("version-1", { matchId: "match-1" })).resolves.toEqual(version);
    const file = await api.getVersionFile("version-1", "dist/game.js", { matchId: "match-1" });
    expect(await file.text()).toBe("export default 1;");
    expect(calls.map((call) => call.url)).toEqual([
      "http://api.test/api/versions/version-1",
      "http://api.test/api/versions/version-1/files/dist/game.js",
    ]);
    expect(scopes).toEqual([{ matchId: "match-1" }, { matchId: "match-1" }]);
    expect(headers(calls[1]).authorization).toBe("Bearer guest-token");
    expect(calls[1]?.init.credentials).toBe("omit");
  });

  test("file downloads reject unsafe paths and report error envelopes", async () => {
    const { api, calls } = harness(() =>
      json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, 403),
    );
    await expect(api.getVersionFile("version-1", "../secret")).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const error = await api.getVersionFile("version-1", "assets/a.png").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("FORBIDDEN");
  });
});
