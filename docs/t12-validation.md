# T12 validation: web app shell

Completed on 2026-11-03 on the `claude/t12-web-app-shell` branch, based on `1c9e726`
(T10 complete). T11 (room server) was developed in parallel and is not part of this branch.

## Delivered

- `apps/web` is a React 19 + Vite 8 single-page app on http://localhost:5173, started by
  `pnpm dev`. Versions and reasons are in [tech-stack.md](tech-stack.md). React, React Router,
  TanStack Query and oidc-client-ts are the tech-stack defaults; D-009 asked for React to be
  confirmed before T12, and per T01 the default was used without a new decision.
- Routes: home, `/projects`, `/games`, `/games/:gameId`, `/matches`, `/join/:token`,
  `/matches/:matchId/lobby`, `/matches/:matchId` (placeholder for T14),
  `/matches/:matchId/replay` (placeholder for T18) and the OIDC callback `/auth/callback`.
  A shared layout has navigation and sign-in; lists have empty states. Projects shows an empty
  state until T15. Designer pages explain sign-in instead of redirecting, because guests never
  need an account.
- A typed API client (`src/api/client.ts`) validates request bodies and queries with
  `HTTP_CONTRACTS` and parses every response with the strict `@bgp/schema` schemas. Error
  envelopes become `ApiError` with the documented code; any other body becomes
  `UnexpectedResponseError`. Requests send bearer tokens only, never cookies.
- OIDC sign-in (`src/auth/auth.ts`) uses the authorization code flow with PKCE for the
  Keycloak `bgp-web` client. The user and its access, refresh and ID tokens are kept in an
  in-memory store (D-007). Only the short-lived sign-in request state (PKCE verifier and
  return path) is written to session storage, because it must survive the redirect;
  oidc-client-ts removes it when the callback completes. Return paths are limited to in-app
  paths.
- Invite claim stores the claimed seat and guest token in memory and opens the lobby. A guest
  token is sent only for its own match. The lobby reads the match summary over HTTP every 3 s
  while the match waits; the WebSocket client is T14's.

## Fixes outside the web app

- **Keycloak realm.** Keycloak 26 adds `sub` to access tokens only through the `basic` client
  scope, and `bgp-web` did not have it. The API requires `sub` (T09), so it rejected every real
  access token with 401. Earlier tasks verified tokens from an ephemeral test issuer and never
  sent a Keycloak token to the API (see t10-validation.md). `infra/keycloak/bgp-realm.json`
  now lists `basic`, and `e2e/local-auth.spec.ts` asserts the claim. Realm imports only
  create missing realms, so an existing local Keycloak keeps the old client until `basic` is
  added in the admin console or the services are reset ([dev-environment.md](dev-environment.md#keycloak-realm-infrakeycloakbgp-realmjson)).
- **End-to-end database.** `scripts/e2e-database.ts` creates and migrates `bgp_e2e` for the
  Playwright API server. The development database could hold designer1 games, and the server
  integration tests assume their database has no committed rows.
- No `apps/server` code changed. Its CORS already allows `PUBLIC_WEB_ORIGIN` without
  credentials.

## Checks

| Command           | Evidence                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| `pnpm build`      | 10 build tasks pass; the web bundle builds into `apps/web/dist`                  |
| `pnpm typecheck`  | 17 tasks plus root tooling pass                                                  |
| `pnpm lint`       | Biome and package-boundary checks pass                                           |
| `pnpm test`       | 17 tasks pass, including 50 web tests, and 55 root tooling tests                 |
| `pnpm check:wasm` | Passes; the web output has no WASM (only the server's QuickJS module is present) |
| `pnpm test:e2e`   | 44 of 45 pass in Chromium, Firefox and WebKit; see the note below                |

Web unit tests cover the config, the API client against a fake `fetch` (headers, no cookies,
body and query validation, scoped guest tokens, error envelopes, a response with a `seed`
field rejected), the auth service against a fake manager and the real `UserManager` settings
(in-memory user store, safe return paths, single redemption of a callback, expired tokens never
handed out, sign-out), and static renders of every route and empty state.

**Done-when check.** `e2e/web-app.spec.ts` has two tests. In the first, designer1 opens
`/games`, signs in through the Keycloak form and returns to `/games` with "Designer One" in
the header and the "No games yet" empty state, which renders only after `GET /api/games`
accepted the access token; web storage and cookies hold nothing token-like afterwards. In the
second, a fixture signs in as designer2 with PKCE, publishes a small sandbox version through
the HTTP API (create game, draft, upload, finalize) and creates a two-seat match. A guest in a
fresh browser context opens the invite link, enters a display name and reaches the lobby,
which shows "Seat 1 Guest Tess (you)" and "Seat 2 Open"; a second guest on the same link sees
the server's "This seat is already taken". Both tests pass in all three browsers.

These runs used a disposable Keycloak 26.8.0 container on port 18080 that imported this
branch's realm file (`OIDC_ISSUER=http://localhost:18080/realms/bgp`), because the shared
local Keycloak predates the realm fix. Against the unchanged shared Keycloak, the app tests
fail with 401 and the new `sub` assertion fails, as expected.

The one failing test is the T07 account-console sign-in (`local-auth.spec.ts`): the console
sometimes still shows "Loading the Account Console" after the 5 s assertion timeout, in a
different browser each time. It also fails intermittently against the shared Keycloak with no
T12 change involved, and passes when rerun.

## Not covered here

- A reload forgets the designer session and guest seats, because tokens are memory-only
  (Q-018, needed for AC-06 in T14).
- Lobby start, create match, invite copy buttons and game and version pages are T17's; match,
  table and replay views are T14's and T18's.
- `pnpm dev` was not run end to end in this worktree: it runs `docker compose up`, which would
  recreate the shared PostgreSQL container with the checked-in port. The same Vite command
  (`pnpm --filter @bgp/web dev`) and API ran under Playwright.
