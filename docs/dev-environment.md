# Development environment

## Prerequisites

- **Node.js** active LTS, matching `.nvmrc` (use nvm, fnm or Volta).
- **pnpm**, version pinned in the root `package.json` `packageManager` field. Install it with npm or pnpm's standalone installer; do not rely on Corepack, which newer Node releases no longer bundle.
- **Docker** with Compose, for PostgreSQL and Keycloak.
- Playwright browsers: `pnpm exec playwright install --with-deps` (first run only).

## First run

### T01 scaffold

The workspace currently contains empty packages. Use Node `24.22.1` (`.nvmrc`) and pnpm
`11.9.0` (`packageManager`). Run `pnpm install --frozen-lockfile`, then `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm check:wasm`.
Install Chromium with `pnpm exec playwright install chromium`, then run
`pnpm test:e2e --project=chromium`. Install all browsers to run the full harness matrix.

`pnpm dev` currently runs two scaffold watchers; there is no HTTP API or web UI yet.
Docker services, image pins, the realm and migrations arrive in T07. `db:generate` and
`db:migrate` return a nonzero exit code with a T07 message until then. Schema export is
pending T02 and PERF-01 is pending T20; their commands likewise fail explicitly.

The root `.env.example` includes both server and web settings. The launcher reads root `.env`
and passes its values to child processes. Per-app examples document each app's settings;
the Vite app will load its own env files when implemented. Generate `GUEST_TOKEN_SECRET`
locally using the command in the example; the checked-in value is deliberately empty.

### Full development environment (from T07 onward)

```bash
pnpm install
cp .env.example .env                    # defaults work for local development
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm dev                                # API :3000 from T10, web app :5173 from T12
```

Open http://localhost:5173. Sign in with a test user from the Keycloak realm (below).

## Services

| Service           | Port | Notes                                                      |
| ----------------- | ---- | ---------------------------------------------------------- |
| Web app (Vite)    | 5173 |                                                            |
| API + room server | 3000 | WebSocket at `/ws`                                         |
| PostgreSQL        | 5432 | Databases `bgp` and `bgp_test` (created by an init script) |
| Keycloak          | 8080 | Admin console at `/admin`, admin / admin locally           |

`infra/docker-compose.yml` (pin image tags at scaffold time and record them in tech-stack.md):

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: bgp
      POSTGRES_PASSWORD: bgp
      POSTGRES_DB: bgp
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro # creates bgp_test
  keycloak:
    image: quay.io/keycloak/keycloak:<pinned>
    command: start-dev --import-realm
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
    ports: ["8080:8080"]
    volumes:
      - ./keycloak:/opt/keycloak/data/import:ro
volumes:
  pgdata: {}
```

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
