# T07 validation

T07 is complete in the `codex/t07-database` worktree. It uses the documented defaults:
Drizzle ORM 0.45.4, drizzle-kit 0.31.11 and postgres 3.4.9. Service images are PostgreSQL
17.11 and Keycloak 26.8.0; upstream release and configuration sources are linked in
[infra/README.md](../infra/README.md).

## Scope

- Compose starts health-checked PostgreSQL and Keycloak on loopback. A fresh PostgreSQL
  volume initializes `bgp` and `bgp_test`; the realm imports both designer accounts,
  their default account roles, the PKCE S256 web client and the `bgp-api` audience mapper.
- Drizzle models all nine documented tables, including stretch-goal feedback storage.
  Versioned migrations create the schema and reject updates, deletes and truncation of
  accepted match history. Keys, uniqueness, foreign keys and basic numeric bounds are
  enforced by PostgreSQL. Application transaction and validation responsibilities remain
  documented in [dev-environment.md](dev-environment.md#database-development-and-integration-tests).
- Migration commands load root `.env` and serialize startup with an advisory lock.
  Server tests automatically migrate a separate `_test` database and roll back fixtures.
- `pnpm dev` waits for healthy services and migrates before starting watchers. CI checks
  migration metadata and schema drift, starts services and runs database/browser tests.

## Checks run locally

Validated on Windows with Node 24.12.0 (within the configured engine range), pnpm 11.9.0,
Docker Engine 29.7.2 and Linux containers. The repository's `.nvmrc` remains 24.22.1;
CI uses that pinned runtime. These are local results; hosted CI has not been run.

| Check                                                                 | Result                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` in the new worktree                  | Passed                                                                                               |
| `docker compose -f infra/docker-compose.yml config --quiet`           | Passed                                                                                               |
| Fresh service startup with `up -d --wait` and a new PostgreSQL volume | Both healthy; `bgp_test` created by init SQL                                                         |
| `pnpm db:generate` repeated after generation                          | No schema changes                                                                                    |
| `pnpm --filter @bgp/server exec drizzle-kit check`                    | Passed                                                                                               |
| `pnpm db:migrate` twice on development database                       | Passed both times                                                                                    |
| `pnpm typecheck`                                                      | Passed                                                                                               |
| `pnpm lint`                                                           | Passed, including package boundaries                                                                 |
| `pnpm test`                                                           | Passed: 171 package tests and 45 tooling tests                                                       |
| Server integration coverage                                           | 15 real PostgreSQL tests, 4 database URL safety tests, 1 existing scaffold test                      |
| `pnpm test:e2e --project=chromium`                                    | 4 passed: both account-page logins, PKCE/audience check, existing browser harness                    |
| `pnpm build`                                                          | All 10 workspace builds passed                                                                       |
| `pnpm check:wasm` after build                                         | Passed; no WASM modules added                                                                        |
| `pnpm dev` smoke check                                                | Healthy services, migrations and both existing app watchers started; smoke process tree then stopped |

The browser test caught missing default roles on imported accounts; explicit
`default-roles-bgp` assignments fix the account console. The PKCE test completes a real
browser login, captures the authorization redirect, exchanges the code and checks the
issuer/audience. It also verifies that a request without a PKCE challenge is rejected.

The HTTP API and web UI remain the T10/T12 scaffold watchers. No T09 authentication
plugin or endpoint behavior is claimed here. Chromium was run locally; the full browser
matrix remains configured for nightly CI. Services are left running for subsequent work.
