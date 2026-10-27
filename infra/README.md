# Local services

Run `docker compose -f infra/docker-compose.yml up -d --wait` from the repository root.
The `bgp-local` Compose project is shared by worktrees on the same machine. PostgreSQL
listens on localhost:5432, with `bgp` / `bgp` credentials and databases `bgp` and `bgp_test`.
The init SQL creates the test database only for a new volume. Run `pnpm db:migrate`
for the development database; integration tests migrate the test database themselves.

Keycloak listens on localhost:8080. Its admin console uses `admin` / `admin`.
Open <http://localhost:8080/realms/bgp/account/> and sign in with `designer1` / `designer1`
or `designer2` / `designer2`. The imported `bgp-web` public client uses authorization
code flow with PKCE S256; its access tokens include the `bgp-api` audience.

These credentials and `start-dev` are for local development only. Realm edits apply
when the Keycloak container is recreated, because its development database is ephemeral.
`docker compose -f infra/docker-compose.yml down` preserves PostgreSQL data; adding `-v`
removes the local volume and both databases. Coordinate resets with other worktrees.

Image pins: [PostgreSQL 17.11](https://www.postgresql.org/docs/17/release-17-11.html)
and [Keycloak 26.8.0](https://www.keycloak.org/2026/10/keycloak-2680-released).
Realm import and health checks follow the [Keycloak container guide](https://www.keycloak.org/server/containers)
and [health guide](https://www.keycloak.org/observability/health).
