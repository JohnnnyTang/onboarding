import {
  GuestClaimsSchema,
  type GuestScope,
  GuestScopeSchema,
  type OidcClaims,
  OidcClaimsSchema,
  type UserResponse,
} from "@bgp/schema";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { createId } from "../db/id.js";
import type { UserStore } from "./user-store.js";

const GUEST_TYPE = "bgp-guest+jwt";
const GUEST_LIFETIME = 30 * 24 * 60 * 60;
export type CallerIdentity =
  | { kind: "user"; user: UserResponse }
  | ({ kind: "guest"; subject: string } & GuestScope);

export class AuthError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "FORBIDDEN") {
    super(code === "UNAUTHORIZED" ? "Missing or invalid credentials" : "Access denied");
  }
}

export interface AuthOptions {
  oidc: { issuer: string; audience: string; jwksUrl: string };
  /** UTF-8 secret, at least 32 bytes; generate with randomBytes(32).toString('base64'). */
  guestTokenSecret: string;
  users: UserStore;
}

export function createAuthService(options: AuthOptions) {
  const issuer = new URL(options.oidc.issuer);
  const jwksUrl = new URL(options.oidc.jwksUrl);
  if (
    ![issuer, jwksUrl].every((url) => ["https:", "http:"].includes(url.protocol)) ||
    !options.oidc.audience ||
    options.oidc.issuer === "bgp:guest"
  ) {
    throw new Error("Invalid OIDC configuration");
  }
  const secret = new TextEncoder().encode(options.guestTokenSecret);
  if (secret.byteLength < 32) throw new Error("GUEST_TOKEN_SECRET must contain at least 32 bytes");
  const jwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 3_000 });

  async function verifyGuest(token: string): Promise<CallerIdentity> {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      typ: GUEST_TYPE,
      issuer: "bgp:guest",
      audience: "bgp:api",
      requiredClaims: ["sub", "iat", "exp", "matchId", "seat"],
      maxTokenAge: GUEST_LIFETIME,
    });
    const claims = GuestClaimsSchema.parse(payload);
    return { kind: "guest", subject: claims.sub, matchId: claims.matchId, seat: claims.seat };
  }

  async function authenticate(authorization: string | undefined): Promise<CallerIdentity> {
    const match = /^Bearer ([^\s,]+)$/i.exec(authorization ?? "");
    const token = match?.[1];
    if (!token || token.length > 16_384) throw new AuthError("UNAUTHORIZED");
    // Only verification failures become 401s. Database outages remain server errors.
    let claims: OidcClaims;
    try {
      if (decodeProtectedHeader(token).typ === GUEST_TYPE) return await verifyGuest(token);
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ["RS256"],
        issuer: options.oidc.issuer,
        audience: options.oidc.audience,
        requiredClaims: ["sub", "exp"],
      });
      claims = OidcClaimsSchema.parse(payload);
    } catch {
      throw new AuthError("UNAUTHORIZED");
    }
    return { kind: "user", user: await options.users.upsert(claims) };
  }

  async function issueGuestToken(scope: GuestScope): Promise<string> {
    const checked = GuestScopeSchema.parse(scope);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(checked)
      .setProtectedHeader({ alg: "HS256", typ: GUEST_TYPE })
      .setIssuer("bgp:guest")
      .setAudience("bgp:api")
      .setSubject(createId())
      .setIssuedAt(now)
      .setExpirationTime(now + GUEST_LIFETIME)
      .sign(secret);
  }

  return { authenticate, issueGuestToken };
}
export type AuthService = ReturnType<typeof createAuthService>;

/** User ownership and seat membership still require database checks by the route. */
export function requireMatchScope(identity: CallerIdentity, matchId: string, seat?: string): void {
  if (
    identity.kind === "guest" &&
    (identity.matchId !== matchId || (seat !== undefined && identity.seat !== seat))
  ) {
    throw new AuthError("FORBIDDEN");
  }
}
