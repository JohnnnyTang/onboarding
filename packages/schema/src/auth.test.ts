import { describe, expect, it } from "vitest";
import { GuestClaimsSchema, GuestScopeSchema, OidcClaimsSchema } from "./auth.js";

describe("authentication claims", () => {
  const guest = {
    iss: "bgp:guest",
    aud: "bgp:api",
    sub: "guest-1",
    matchId: "match-1",
    seat: "0",
    iat: 100,
    exp: 2_592_100,
  };
  it("validates guest claims with an exact 30-day lifetime", () => {
    expect(GuestClaimsSchema.parse(guest)).toEqual(guest);
    for (const change of [
      { seat: 0 },
      { seat: "01" },
      { matchId: "" },
      { exp: 200 },
      { iat: 1.5 },
      { extra: true },
    ]) {
      expect(GuestClaimsSchema.safeParse({ ...guest, ...change }).success).toBe(false);
    }
    expect(
      GuestScopeSchema.safeParse({ matchId: "match-1", seat: "0", userId: "admin" }).success,
    ).toBe(false);
  });
  it("checks required OIDC claims and discards unrelated provider fields", () => {
    const claims = {
      iss: "https://issuer.example.test",
      aud: ["bgp-api"],
      sub: "designer",
      exp: 100,
    };
    expect(OidcClaimsSchema.parse({ ...claims, realm_access: { roles: ["admin"] } })).toEqual(
      claims,
    );
    for (const change of [
      { sub: "" },
      { exp: 1.1 },
      { aud: [] },
      { email: false },
      { iss: "invalid" },
    ]) {
      expect(OidcClaimsSchema.safeParse({ ...claims, ...change }).success).toBe(false);
    }
  });
});
