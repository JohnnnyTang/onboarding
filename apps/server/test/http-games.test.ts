import {
  GameDetailResponseSchema,
  GameListResponseSchema,
  GameResponseSchema,
  HttpErrorSchema,
  UserResponseSchema,
} from "@bgp/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGame, type Harness, startHarness, WEB_ORIGIN, withApi } from "./api-fixture.js";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness?.close();
});

const code = (response: { json(): unknown }) => HttpErrorSchema.parse(response.json()).error.code;

describe("health, me and errors", () => {
  it("serves health without credentials and the current user with them", async () => {
    await withApi(harness, async (api) => {
      expect((await api.call("GET", "/api/healthz")).json()).toEqual({ ok: true });
      const anonymous = await api.call("GET", "/api/me");
      expect([anonymous.statusCode, code(anonymous)]).toEqual([401, "UNAUTHORIZED"]);
      const me = await api.call("GET", "/api/me", { token: await api.designer() });
      expect(UserResponseSchema.parse(me.json())).toMatchObject({ displayName: "designer-1" });
    });
  });

  it("uses the error envelope for unknown routes and malformed bodies", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const missing = await api.call("GET", "/api/nothing", { token });
      expect([missing.statusCode, code(missing)]).toEqual([404, "NOT_FOUND"]);
      const malformed = await api.call("POST", "/api/games", {
        token,
        body: Buffer.from("{not json"),
        headers: { "content-type": "application/json" },
      });
      expect([malformed.statusCode, code(malformed)]).toEqual([400, "BAD_MESSAGE"]);
      const tooLarge = await api.call("POST", "/api/games", {
        token,
        body: Buffer.from(JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) })),
        headers: { "content-type": "application/json" },
      });
      expect([tooLarge.statusCode, code(tooLarge)]).toEqual([413, "VALIDATION_FAILED"]);
    });
  });

  it("answers CORS preflight for the web origin only, without credentials", async () => {
    await withApi(harness, async (api) => {
      const preflight = await api.call("OPTIONS", "/api/games", {
        headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      expect(preflight.headers["access-control-allow-headers"]).toContain("x-content-sha256");
      expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
      const other = await api.call("OPTIONS", "/api/games", {
        headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
      });
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
});

describe("games", () => {
  it("creates, lists, reads and renames the caller's own games", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const created = await api.call("POST", "/api/games", {
        token,
        body: { slug: "first-game", name: "First", visibility: "private" },
      });
      expect(created.statusCode).toBe(201);
      const game = GameResponseSchema.parse(created.json());
      expect(game).toMatchObject({ slug: "first-game", name: "First", visibility: "private" });
      const second = await createGame(api, token, "second-game");
      await createGame(api, await api.designer("designer-2"), "someone-else");

      const page1 = GameListResponseSchema.parse(
        (await api.call("GET", "/api/games?limit=1", { token })).json(),
      );
      expect(page1.items.map((item) => item.id)).toEqual([second]);
      const page2 = GameListResponseSchema.parse(
        (await api.call("GET", `/api/games?limit=1&cursor=${page1.cursor}`, { token })).json(),
      );
      expect(page2).toEqual({ items: [game], cursor: null });

      const detail = await api.call("GET", `/api/games/${game.id}`, { token });
      expect(GameDetailResponseSchema.parse(detail.json())).toEqual({ ...game, versions: [] });
      const patched = await api.call("PATCH", `/api/games/${game.id}`, {
        token,
        body: { name: "Renamed", visibility: "unlisted" },
      });
      expect(patched.json()).toEqual({ ...game, name: "Renamed", visibility: "unlisted" });
    });
  });

  it("validates bodies and queries", async () => {
    await withApi(harness, async (api) => {
      const token = await api.designer();
      const gameId = await createGame(api, token, "first-game");
      for (const [method, url, body] of [
        ["POST", "/api/games", { slug: "x", name: "Bad slug", visibility: "private" }],
        ["POST", "/api/games", { slug: "public-game", name: "Public", visibility: "public" }],
        [
          "POST",
          "/api/games",
          { slug: "extra-game", name: "Extra", visibility: "private", owner: "me" },
        ],
        ["PATCH", `/api/games/${gameId}`, {}],
        ["GET", "/api/games?limit=0", undefined],
        ["GET", "/api/games?limit=201", undefined],
        ["GET", "/api/games?cursor=not-a-uuid", undefined],
        ["GET", "/api/games?unknown=1", undefined],
      ] as const) {
        const response = await api.call(method, url, { token, body });
        expect([response.statusCode, code(response)], `${method} ${url}`).toEqual([
          400,
          "BAD_MESSAGE",
        ]);
      }
      const duplicate = await api.call("POST", "/api/games", {
        token: await api.designer("designer-2"),
        body: { slug: "first-game", name: "Again", visibility: "private" },
      });
      expect([duplicate.statusCode, code(duplicate)]).toEqual([409, "CONFLICT"]);
    });
  });

  it("allows only the owner to read or change a game", async () => {
    await withApi(harness, async (api) => {
      const gameId = await createGame(api, await api.designer(), "first-game");
      const other = await api.designer("designer-2");
      for (const [method, body] of [
        ["GET", undefined],
        ["PATCH", { name: "Mine now" }],
        ["POST", undefined],
      ] as const) {
        const url = method === "POST" ? `/api/games/${gameId}/versions` : `/api/games/${gameId}`;
        const response = await api.call(method, url, { token: other, body });
        expect([response.statusCode, code(response)], method).toEqual([403, "FORBIDDEN"]);
      }
      const unknown = await api.call("GET", "/api/games/00000000-0000-7000-8000-000000000000", {
        token: other,
      });
      expect([unknown.statusCode, code(unknown)]).toEqual([404, "NOT_FOUND"]);
      const malformed = await api.call("GET", "/api/games/not-a-uuid", { token: other });
      expect([malformed.statusCode, code(malformed)]).toEqual([404, "NOT_FOUND"]);
      expect((await api.call("GET", "/api/games")).statusCode).toBe(401);
    });
  });
});
