import { HttpErrorSchema, type OidcClaims } from "@bgp/schema";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../src/auth/plugin.js";
import { type AuthService, createAuthService } from "../src/auth/service.js";
import { createUserStore, type UserStore } from "../src/auth/user-store.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/connection.js";
import { users } from "../src/db/schema.js";
import { startIssuer, TEST_SECRET } from "./auth-fixture.js";
import { testDatabaseUrl } from "./database.js";

let connection: DatabaseConnection;
let issuer: Awaited<ReturnType<typeof startIssuer>>;
type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];
beforeAll(async () => {
  connection = connectDatabase(testDatabaseUrl());
  issuer = await startIssuer();
});
afterAll(async () => {
  await issuer.close();
  await connection.close();
});

async function fixture(
  run: (context: {
    app: FastifyInstance;
    auth: AuthService;
    store: UserStore;
    tx: Transaction;
  }) => Promise<void>,
): Promise<void> {
  const rollback = new Error("rollback successful authentication fixture");
  try {
    await connection.db.transaction(async (tx) => {
      const store = createUserStore(tx);
      const auth = createAuthService({
        oidc: issuer.oidc,
        guestTokenSecret: TEST_SECRET,
        users: store,
      });
      const app = Fastify();
      await app.register(authPlugin, { auth });
      // Separate plugin scopes exercise Fastify's encapsulation and decoration rules.
      await app.register(async (routes) => {
        routes.get("/api/me", (request) => request.identity);
        routes.get("/api/healthz", { config: { auth: "none" } }, (request) => ({
          identity: request.identity,
        }));
        routes.post("/optional", { config: { auth: "optional" } }, (request) => ({
          identity: request.identity,
        }));
        routes.get(
          "/api/matches/:matchId",
          { config: { auth: "match" } },
          (request) => request.identity,
        );
      });
      try {
        await run({ app, auth, store, tx });
      } finally {
        await app.close();
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function userRows(tx: Transaction) {
  return tx.select().from(users).where(eq(users.oidcIssuer, issuer.oidc.issuer));
}

describe("Fastify request identity and authorization", () => {
  it("upserts a verified designer and attaches only the public user profile", async () => {
    await fixture(async ({ app, tx }) => {
      const token = await issuer.token();
      const response = await app.inject({
        url: "/api/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const [row] = await userRows(tx);
      expect(row).toMatchObject({
        oidcSubject: "designer-1",
        displayName: "Designer One",
        email: "one@example.test",
      });
      expect(row?.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      expect(response.json()).toEqual({
        kind: "user",
        user: { id: row?.id, displayName: "Designer One", email: "one@example.test" },
      });
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain("oidcSubject");
    });
  });
  it("returns generic contract errors for every required invalid user-token case", async () => {
    await fixture(async ({ app, tx }) => {
      const invalidTokens = [
        await issuer.token({ exp: 1 }),
        await issuer.token({ aud: "other" }),
        await issuer.token({ iss: "https://wrong.example.test" }),
        await issuer.token({}, true),
        "malformed",
      ];
      for (const token of invalidTokens) {
        const response = await app.inject({
          url: "/api/me",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
        expect(HttpErrorSchema.parse(response.json())).toEqual({
          error: { code: "UNAUTHORIZED", message: "Missing or invalid credentials" },
        });
        expect(response.body).not.toContain(token);
      }
      expect(await userRows(tx)).toHaveLength(0);
    });
  });
  it("requires the Authorization header, rejects cookie/query credentials and defaults routes to user-only", async () => {
    await fixture(async ({ app }) => {
      const token = await issuer.token();
      for (const request of [
        { url: "/api/me" },
        { url: `/api/me?access_token=${token}`, headers: { cookie: `access_token=${token}` } },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(401);
        expect(HttpErrorSchema.parse(response.json()).error.code).toBe("UNAUTHORIZED");
      }
    });
  });
  it("accepts guests only within their match and rejects them on user-only and optional-user routes", async () => {
    await fixture(async ({ app, auth, tx }) => {
      const token = await auth.issueGuestToken({ matchId: "one", seat: "2" });
      const headers = { authorization: `Bearer ${token}` };
      const rightMatch = await app.inject({ url: "/api/matches/one", headers });
      expect(rightMatch.statusCode).toBe(200);
      expect(rightMatch.json()).toMatchObject({ kind: "guest", matchId: "one", seat: "2" });
      for (const request of [
        { url: "/api/matches/two", headers },
        { url: "/api/me", headers },
        { method: "POST" as const, url: "/optional", headers },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(403);
        expect(HttpErrorSchema.parse(response.json())).toEqual({
          error: { code: "FORBIDDEN", message: "Access denied" },
        });
      }
      expect(await userRows(tx)).toHaveLength(0);
    });
  });
  it("keeps public and optional calls anonymous and isolates identity between requests", async () => {
    await fixture(async ({ app }) => {
      const token = await issuer.token();
      expect(
        (await app.inject({ url: "/api/me", headers: { authorization: `Bearer ${token}` } }))
          .statusCode,
      ).toBe(200);
      for (const request of [
        { url: "/api/healthz" },
        { method: "POST" as const, url: "/optional" },
        { url: "/api/healthz", headers: { authorization: "Bearer invalid" } },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ identity: null });
      }
      const signedIn = await app.inject({
        method: "POST",
        url: "/optional",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(signedIn.json()).toMatchObject({ identity: { kind: "user" } });
      const invalid = await app.inject({
        method: "POST",
        url: "/optional",
        headers: { authorization: "Bearer invalid" },
      });
      expect(invalid.statusCode).toBe(401);
      expect((await app.inject({ url: "/api/me" })).statusCode).toBe(401);
    });
  });
});

describe("PostgreSQL user identity upserts", () => {
  const claims = (): OidcClaims => ({
    iss: issuer.oidc.issuer,
    aud: "bgp-api",
    sub: "designer-1",
    exp: 2_000_000_000,
  });
  it("keeps the same ID and creation time while refreshing the token profile", async () => {
    await fixture(async ({ store, tx }) => {
      const original = await store.upsert({
        ...claims(),
        name: "Original",
        email: "old@example.test",
      });
      const [before] = await userRows(tx);
      const updated = await store.upsert({
        ...claims(),
        name: "Updated",
        email: "new@example.test",
      });
      const rows = await userRows(tx);
      expect(rows).toHaveLength(1);
      expect(updated).toEqual({
        id: original.id,
        displayName: "Updated",
        email: "new@example.test",
      });
      expect(rows[0]?.createdAt).toEqual(before?.createdAt);
    });
  });
  it("supports absent profile fields and caps names at the HTTP contract limit", async () => {
    await fixture(async ({ store }) => {
      expect(await store.upsert(claims())).toMatchObject({
        displayName: "designer-1",
        email: null,
      });
      expect(await store.upsert({ ...claims(), preferred_username: "username" })).toMatchObject({
        displayName: "username",
      });
      expect(await store.upsert({ ...claims(), name: "x".repeat(100) })).toMatchObject({
        displayName: "x".repeat(80),
      });
    });
  });
  it("handles repeated simultaneous upserts and scopes identities by issuer plus subject", async () => {
    await fixture(async ({ store, tx }) => {
      const profiles = await Promise.all(Array.from({ length: 8 }, () => store.upsert(claims())));
      expect(new Set(profiles.map((profile) => profile.id)).size).toBe(1);
      expect(await userRows(tx)).toHaveLength(1);
      const otherSubject = await store.upsert({ ...claims(), sub: "designer-2" });
      const otherIssuer = await store.upsert({ ...claims(), iss: "https://other.example.test" });
      expect(
        new Set([...profiles.map((profile) => profile.id), otherSubject.id, otherIssuer.id]).size,
      ).toBe(3);
      const rows = await tx
        .select()
        .from(users)
        .where(and(eq(users.oidcIssuer, claims().iss), eq(users.oidcSubject, claims().sub)));
      expect(rows).toHaveLength(1);
    });
  });
});
