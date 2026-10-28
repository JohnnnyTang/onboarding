# T09 validation: authentication

Completed on 2026-10-27 in the dedicated `codex/t09-authentication` worktree,
based on `cba6a6c`. T04 and T08 are independent worktrees; this change does not
implement their runtime or isolation work.

## Delivered

- `createAuthService` verifies OIDC access tokens using the configured issuer,
  audience, RS256 algorithm and a trusted remote JWKS endpoint. It requires
  subject and expiry, checks `nbf` when present, and validates verified profile
  claims with `@bgp/schema` before calling the user store. Signing keys are cached
  by `jose`; token-provided key URLs are not used.
- `createUserStore` performs a PostgreSQL upsert keyed by issuer plus subject.
  Existing IDs and creation timestamps remain stable while the public profile
  is refreshed. New IDs are cryptographic UUID v7 values. Tests roll back their
  fixtures and never clear shared database tables.
- Guest issuance signs an HS256 JWT scoped to one match and seat for exactly
  30 days. The guest token type, issuer and audience are distinct from OIDC.
  Scope and verified claims have shared Zod validators and JSON Schema exports.
- `authPlugin` installs a fresh caller identity for each Fastify request and
  defaults routes to user-only authentication. Public, optional-user and
  match-scoped policies are explicit. Wrong-match guests receive `FORBIDDEN`;
  bad credentials receive `UNAUTHORIZED` without verification details or tokens.
- The existing Fastify default and decided `jose` library are pinned with
  `fastify-plugin`; the dependency table and boundary checker admit those libraries.

## Checks

All of the following passed in this worktree:

| Command                          | Evidence                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| `pnpm build`                     | All 10 workspace packages build                                     |
| `pnpm typecheck`                 | Workspace production/test types and root tooling pass               |
| `pnpm lint`                      | Biome and package-boundary checks pass                              |
| `pnpm test`                      | All package tests and 45 root tooling tests pass                    |
| `pnpm --filter @bgp/server test` | 44 tests, including 24 authentication tests                         |
| `pnpm --filter @bgp/schema test` | 135 tests, including authentication claim validation                |
| `pnpm json-schema`               | Exports 112 schemas, including the three new authentication schemas |
| `pnpm check:wasm`                | Passes with zero WASM modules                                       |

The T09 acceptance cases all exercise real signatures against a local HTTP JWKS
endpoint: valid designer, expired token, wrong audience, wrong issuer, tampered
signature, valid guest in its match, and guest in a different match. Fastify
injection tests also check the HTTP status and documented error envelope.
PostgreSQL tests verify stable IDs, profile updates, profile fallbacks, repeated
concurrent upserts and issuer/subject separation. Additional rejection cases cover
missing required claims, future validity, algorithm confusion, malformed credentials,
wrong guest secrets, changed guest lifetimes and invalid guest scopes.

The tests use an ephemeral OIDC issuer and the real local PostgreSQL `bgp_test`
database. No Keycloak realm settings were changed. The existing T07 browser tests
own the Keycloak PKCE and audience-mapper checks.

## Integration for T10 and T11

The package exports `createAuthService`, `createUserStore`, `authPlugin`,
`requireMatchScope`, their option/identity types and `AuthError`. The HTTP server
can assemble them before registering routes:

```ts
const auth = createAuthService({
  oidc: {
    issuer: config.oidcIssuer,
    audience: config.oidcAudience,
    jwksUrl: config.oidcJwksUrl,
  },
  guestTokenSecret: config.guestTokenSecret,
  users: createUserStore(connection.db),
});
await app.register(authPlugin, { auth });
```

`OIDC_JWKS_URL` is documented in both environment examples; locally it points to
the Keycloak realm certificate endpoint. The issuer and JWKS URL are trusted
server configuration, never values selected from token claims.

T10 owns the HTTP server entry point, endpoint registration and invite claiming.
Use `config.auth: "none"` for health and `"optional"` for invite claims; default
user-only authentication fits designer endpoints. Call `issueGuestToken` only
after a successful guest seat claim. Match routes use `config.auth: "match"`
and still perform database ownership/seat checks. Version downloads need their
own membership lookup. T11 can authenticate its bearer and call
`requireMatchScope(identity, matchId, seat)` before looking up the seat.
Authentication does not itself prove that a designer owns a match or holds a seat.
