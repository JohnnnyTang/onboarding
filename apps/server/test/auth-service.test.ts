import { decodeJwt, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  type AuthService,
  createAuthService,
  requireMatchScope,
} from "../src/auth/service.js";
import { startIssuer, TEST_SECRET } from "./auth-fixture.js";

let issuer: Awaited<ReturnType<typeof startIssuer>>;
let auth: AuthService;
const upsert = vi.fn(async () => ({
  id: "user-1",
  displayName: "Designer One",
  email: "one@example.test",
}));
beforeAll(async () => {
  issuer = await startIssuer();
  auth = createAuthService({ oidc: issuer.oidc, guestTokenSecret: TEST_SECRET, users: { upsert } });
});
afterAll(async () => {
  await issuer.close();
});
beforeEach(() => {
  upsert.mockClear();
});

async function expectUnauthorized(token: string) {
  await expect(auth.authenticate(`Bearer ${token}`)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(upsert).not.toHaveBeenCalled();
}

describe("OIDC access tokens", () => {
  it("verifies real JWKS signatures and caches keys, then upserts the verified identity", async () => {
    const before = issuer.requests();
    const token = await issuer.token();
    expect(await auth.authenticate(`Bearer ${token}`)).toEqual({
      kind: "user",
      user: { id: "user-1", displayName: "Designer One", email: "one@example.test" },
    });
    await auth.authenticate(`bearer ${token}`);
    expect(issuer.requests() - before).toBeLessThanOrEqual(1);
    expect(issuer.requests()).toBeGreaterThan(0);
    expect(upsert).toHaveBeenCalledWith({
      iss: issuer.oidc.issuer,
      sub: "designer-1",
      aud: "bgp-api",
      exp: expect.any(Number),
      name: "Designer One",
      email: "one@example.test",
    });
  });
  it.each([
    ["expired", { exp: 1 }],
    ["wrong audience", { aud: "another-api" }],
    ["wrong issuer", { iss: "https://other.example.test" }],
    ["not yet valid", { nbf: Math.floor(Date.now() / 1000) + 600 }],
    ["empty subject", { sub: "" }],
    ["invalid profile", { email: 123 }],
  ])("rejects %s without touching the database", async (_name, claims) => {
    await expectUnauthorized(await issuer.token(claims));
  });
  it("rejects a signature from another private key with the same key ID", async () => {
    await expectUnauthorized(await issuer.token({}, true));
  });
  it("requires expiry and subject, even with a valid signature", async () => {
    for (const claims of [{ sub: "designer" }, { exp: Math.floor(Date.now() / 1000) + 300 }]) {
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer.oidc.issuer)
        .setAudience("bgp-api")
        .sign(issuer.privateKey);
      await expectUnauthorized(token);
    }
  });
  it("rejects alg:none, symmetric OIDC tokens and malformed credentials", async () => {
    const symmetric = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer.oidc.issuer)
      .setAudience("bgp-api")
      .setSubject("designer")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(TEST_SECRET));
    for (const token of [symmetric, "eyJhbGciOiJub25lIn0.e30.", "broken", "x".repeat(16_385)]) {
      await expectUnauthorized(token);
    }
    for (const value of [undefined, "", "Basic token", "Bearer", "Bearer a,b", "Bearer a b"]) {
      await expect(auth.authenticate(value)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
  it("accepts an audience array containing this API", async () => {
    expect(
      await auth.authenticate(`Bearer ${await issuer.token({ aud: ["bgp-api", "other"] })}`),
    ).toMatchObject({ kind: "user" });
  });
  it("preserves database failures as server errors", async () => {
    const unavailable = createAuthService({
      oidc: issuer.oidc,
      guestTokenSecret: TEST_SECRET,
      users: {
        upsert: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    await expect(unavailable.authenticate(`Bearer ${await issuer.token()}`)).rejects.toThrow(
      "database unavailable",
    );
  });
});

describe("match-scoped guests", () => {
  it("issues a 30-day token for exactly one match and seat without creating a user", async () => {
    const token = await auth.issueGuestToken({ matchId: "match-1", seat: "0" });
    const claims = decodeJwt(token);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(30 * 24 * 60 * 60);
    expect(claims.sub).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    const identity = await auth.authenticate(`Bearer ${token}`);
    expect(identity).toEqual({ kind: "guest", subject: claims.sub, matchId: "match-1", seat: "0" });
    expect(() => requireMatchScope(identity, "match-1", "0")).not.toThrow();
    expect(() => requireMatchScope(identity, "match-2")).toThrow(new AuthError("FORBIDDEN"));
    expect(() => requireMatchScope(identity, "match-1", "1")).toThrow(new AuthError("FORBIDDEN"));
    expect(upsert).not.toHaveBeenCalled();
  });
  it("rejects guest tokens signed with another server secret", async () => {
    const other = createAuthService({
      oidc: issuer.oidc,
      guestTokenSecret: "another-strong-secret-for-a-different-server",
      users: { upsert },
    });
    await expectUnauthorized(await other.issueGuestToken({ matchId: "match-1", seat: "0" }));
  });
  it("rejects expired, future-issued, wrong-type, wrong-issuer, wrong-audience and malformed guest claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      iss: "bgp:guest",
      aud: "bgp:api",
      sub: "guest-1",
      matchId: "match-1",
      seat: "0",
      iat: now,
      exp: now + 2_592_000,
    };
    for (const extra of [
      { iat: now - 2_592_001, exp: now - 1 },
      { iat: now + 600, exp: now + 2_592_600 },
      { iss: "other" },
      { aud: "other" },
      { matchId: "" },
      { seat: "-1" },
      { seat: 0 },
      { sub: "" },
      { exp: now + 60 },
      { matchId: undefined },
    ]) {
      const token = await new SignJWT({ ...base, ...extra })
        .setProtectedHeader({ alg: "HS256", typ: "bgp-guest+jwt" })
        .sign(new TextEncoder().encode(TEST_SECRET));
      await expectUnauthorized(token);
    }
    const wrongType = await new SignJWT(base)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(TEST_SECRET));
    await expectUnauthorized(wrongType);
  });
  it("rejects invalid scope at issuance and short signing secrets at startup", async () => {
    await expect(auth.issueGuestToken({ matchId: "match-1", seat: "-1" })).rejects.toThrow();
    expect(() =>
      createAuthService({ oidc: issuer.oidc, guestTokenSecret: "short", users: { upsert } }),
    ).toThrow("at least 32 bytes");
  });
});
