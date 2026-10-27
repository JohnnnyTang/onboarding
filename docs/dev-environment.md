# Development environment

## Prerequisites

- **Node.js** active LTS, matching `.nvmrc` (use nvm, fnm or Volta).
- **pnpm**, version pinned in the root `package.json` `packageManager` field. Install it with npm or pnpm's standalone installer; do not rely on Corepack, which newer Node releases no longer bundle.
- **Docker** with Compose, for PostgreSQL and Keycloak.
- Playwright browsers: `pnpm exec playwright install --with-deps` (first run only).

## First run

### Workspace and services

Use Node `24.22.1` (`.nvmrc`) and pnpm `11.9.0` (`packageManager`). Install dependencies
with `pnpm install --frozen-lockfile`. PostgreSQL and Keycloak run through Docker Compose;
`pnpm dev` waits for healthy services, applies development database migrations, then starts
the app watchers. The API and web UI remain scaffold watchers until T10 and T12.

The root `.env.example` includes server and web settings. The launcher and migration
command read root `.env`; server integration tests also read it. Existing process environment
values take precedence. Generate `GUEST_TOKEN_SECRET` using the command in the example.

### Full development environment (from T07 onward)

```bash
pnpm install
cp .env.example .env                    # defaults work for local development
docker compose -f infra/docker-compose.yml up -d --wait
pnpm db:migrate
pnpm dev                                # API :3000 from T10, web app :5173 from T12
```

From T12, open http://localhost:5173 for the web app. In T07, verify sign-in directly at
http://localhost:8080/realms/bgp/account/ using a test user listed below.

## Services

| Service           | Port | Notes                                                      |
| ----------------- | ---- | ---------------------------------------------------------- |
| Web app (Vite)    | 5173 |                                                            |
| API + room server | 3000 | WebSocket at `/ws`                                         |
| PostgreSQL        | 5432 | Databases `bgp` and `bgp_test` (created by an init script) |
| Keycloak          | 8080 | Admin console at `/admin`, admin / admin locally           |

The checked-in [Compose file](../infra/docker-compose.yml) pins PostgreSQL `17.11` and
Keycloak `26.8.0`, binds ports to loopback, and health-checks both services. See
[infra/README.md](../infra/README.md) for credentials, persistence and reset behavior.
The Compose project name is `bgp-local`, shared by worktrees on one machine. Coordinate
resets; use a separate `TEST_DATABASE_URL` ending in `_test` when isolated test data is needed.

## Database development and integration tests

The schema lives in `apps/server/src/db/schema.ts`. The server owns Drizzle and the
`postgres` driver behind `connectDatabase`; other packages must not import database code.
After editing the schema, run `pnpm db:generate`, review the SQL and metadata under
`apps/server/drizzle/`, then run `pnpm format` and `pnpm db:migrate`. Commit the schema,
generated SQL and snapshots together. Custom SQL migrations (such as the append-only
match-event guard) are created with `pnpm --filter @bgp/server exec drizzle-kit generate
--custom --name=<name>` and reviewed alongside their tests.

`pnpm db:migrate` loads the root `.env`, defaults to the local `bgp` database, and can
safely run again. Migration startup uses a PostgreSQL advisory lock so simultaneous
worktree and test startup cannot race. No migrations run merely by importing database code.

`pnpm test` includes real PostgreSQL integration tests. Start Docker services first:

```bash
docker compose -f infra/docker-compose.yml up -d --wait
pnpm test
pnpm test:e2e --project=chromium
```

The server's Vitest global setup automatically migrates `TEST_DATABASE_URL` before tests;
no manual test-database migration is needed. It defaults to `bgp_test`, refuses development
database URLs, and fails clearly if PostgreSQL is unavailable. Tests roll back their data
instead of clearing shared tables. The Keycloak browser tests verify both account-page
sign-ins, the web client's PKCE requirement and its `bgp-api` audience. Browser tests need
healthy Keycloak and the Playwright browser installation, but do not yet need the app server.

UUID v7 IDs are supplied by application code; the database does not substitute UUID v4.
JSONB TypeScript types come from `@bgp/schema`; API/runtime/storage boundaries must still
validate JSON with those schemas. Match readiness, manifest-specific seat counts, Phase 1
visibility restrictions, and gapless event insertion with the `last_seq` update belong to
T10/T11 transactions. PostgreSQL already enforces keys, numeric bounds and immutable events.

## Keycloak realm (`infra/keycloak/bgp-realm.json`)

- Realm `bgp`.
- Public client `bgp-web`: standard flow with PKCE (S256), redirect URI `http://localhost:5173/*`, web origin `http://localhost:5173`.
- An audience mapper so access tokens for `bgp-web` include `bgp-api` in `aud`.
- Test users: `designer1` / `designer1`, `designer2` / `designer2` (used by E2E tests).

## Environment variables

Server (`apps/server/.env`):

| Variable                                                                            | Local default                                | Purpose                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PORT`                                                                              | `3000`                                       |                                                                                        |
| `PUBLIC_WEB_ORIGIN`                                                                 | `http://localhost:5173`                      | CORS and invite link base                                                              |
| `DATABASE_URL`                                                                      | `postgres://bgp:bgp@localhost:5432/bgp`      |                                                                                        |
| `TEST_DATABASE_URL`                                                                 | `postgres://bgp:bgp@localhost:5432/bgp_test` | Integration tests                                                                      |
| `OIDC_ISSUER`                                                                       | `http://localhost:8080/realms/bgp`           | Token verification via the issuer's JWKS                                               |
| `OIDC_AUDIENCE`                                                                     | `bgp-api`                                    | Required `aud`                                                                         |
| `GUEST_TOKEN_SECRET`                                                                | 32+ random bytes, base64                     | Signs guest tokens; never commit real values                                           |
| `BLOB_DRIVER`                                                                       | `fs`                                         | `fs` or `s3`                                                                           |
| `BLOB_FS_DIR`                                                                       | `./.data/blobs`                              |                                                                                        |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset                                        | Production storage                                                                     |
| `BUNDLE_CACHE_DIR`                                                                  | `./.data/bundle-cache`                       | Read-only for the rules host                                                           |
| `RULES_HOST_PROCESSES`                                                              | `1`                                          |                                                                                        |
| `RULES_CALL_TIMEOUT_MS`                                                             | `1000`                                       | Per call into game code                                                                |
| `RULES_MEMORY_MB`                                                                   | `64`                                         | Memory cap per match sandbox                                                           |
| `RULES_SANDBOX`                                                                     | `quickjs`                                    | `quickjs` or `node-vm`, so the T08 spike and fallbacks can switch without code changes |
| `LOG_LEVEL`                                                                         | `info`                                       | pino level                                                                             |

Web app (`apps/web/.env`):

| Variable              | Local default                      |
| --------------------- | ---------------------------------- |
| `VITE_API_URL`        | `http://localhost:3000`            |
| `VITE_WS_URL`         | `ws://localhost:3000/ws`           |
| `VITE_OIDC_ISSUER`    | `http://localhost:8080/realms/bgp` |
| `VITE_OIDC_CLIENT_ID` | `bgp-web`                          |

## Useful commands

| Command                                              | Purpose                                            |
| ---------------------------------------------------- | -------------------------------------------------- |
| `pnpm --filter @bgp/rules test --watch`              | Iterate on the runtime                             |
| `pnpm --filter harbor-market exec bgp dev`           | Reference game in a hot-seat table with hot reload |
| `pnpm db:generate` then `pnpm db:migrate`            | After changing the Drizzle schema                  |
| `docker compose -f infra/docker-compose.yml down -v` | Reset local services and data                      |
| `rm -rf .data`                                       | Reset local blobs and bundle cache                 |
