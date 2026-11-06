# Board Game Platform

**From a sketch on a table to a game people can playtest together.**

Board Game Platform is an in-progress, browser-based toolkit for indie board game designers. The idea is to let a designer start with components and manual play, add enforceable rules when ready, and invite remote playtesters without asking them to install an app. The platform supplies the table, networking, accounts, storage, and replay machinery; game packages supply the game.

> **Development status:** This repository is a Phase 1 work in progress, not a ready-to-use playtest service. The deterministic headless core, schema contracts, local database and auth groundwork, isolated rules host, and PixiJS table renderer have substantial implementations. The end-to-end designer and guest flows are still being built. See [the task tracker](docs/tasks.md) for the exact status and validation notes.

## The story

Designers often have to choose between a free-form tabletop that leaves all rules to the players and a coded implementation that demands a finished rulebook up front. This project aims to make that a path rather than a choice:

1. **Sketch:** declare cards, dice, pieces, and zones; move them manually in sandbox mode.
2. **Script:** write a game package against a small rules SDK so the platform can enforce moves and turns.
3. **Playtest:** invite guests by link, preserve each seat's hidden information, and replay what happened.
4. **Learn and present:** later phases add balance analysis and a richer 3D table.

The first audience is indie designers and their invited playtesters. A public game center comes later. The product direction and tradeoffs live in [intent.md](intent.md).

## How it is designed

A game is a deterministic state machine. The same seeded rules and move sequence must produce the same result, whether used for a local test, a remote match, or a replay. Rendering is separate: a game describes components and a table snapshot, while the table renderer decides how to draw them.

Remote matches are server authoritative. Game code runs in an isolated rules host; each client receives only its own permitted view. Sandbox play also hides private zones and rekeys hidden items after shuffles. Those boundaries are part of the product, not optional polish.

```text
Browser: web UI + 2D table + isolated game worker
                    │ HTTP / WebSocket
Server: API + room server ── rules host ── game bundle
                    │
              PostgreSQL + asset storage
```

The intended full system is described in [architecture.md](docs/architecture.md). Implemented pieces and planned connections are distinguished in [tasks.md](docs/tasks.md).

## What is in this repository

| Area                      | Role                                                              | Current state                                                         |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/schema`         | Zod contracts and generated JSON Schemas                          | Implemented                                                           |
| `packages/rules`          | Seeded RNG, rules runtime, sandbox operations, replay and hashing | Implemented                                                           |
| `packages/testing`        | Headless runner, random bot, leak and determinism checks          | Implemented                                                           |
| `packages/rules-host`     | Isolated server-side game execution and recovery client           | Implemented; T08 closure has remaining gates                          |
| `packages/table-2d`       | PixiJS table renderer and gesture handling                        | Implemented; physical-phone qualification remains                     |
| `apps/server`             | Database schema, migrations, and auth foundation                  | HTTP game and match API / room server are pending                     |
| `apps/web`                | Browser application                                               | App shell and product flows are pending; table fixture harness exists |
| `games/harbor-market`     | Enforced reference game                                           | Planned; currently a scaffold                                         |
| `packages/card-generator` | Card faces from templates and CSV rows                            | Implemented (T16)                                                     |
| `packages/cli`            | Developer commands                                                | Planned; currently a scaffold                                         |

The [Phase 1 specification](docs/phase-1-spec.md) defines the complete designer sandbox, remote match, replay, and SDK acceptance criteria. Later 3D and balance-analysis phases are direction, not current features.

## Try the current code

Use Node **24.22.1** (see `.nvmrc`), pnpm **11.9.0**, and Docker with Compose for database-backed tests and local services.

```sh
pnpm install --frozen-lockfile
# Copy .env.example to .env and set GUEST_TOKEN_SECRET for local use.
docker compose -f infra/docker-compose.yml up -d --wait
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm dev` starts the local services and workspace watchers. At this stage the API and web entries are scaffold watchers, so this command does **not** yet open the finished product. To explore the implemented table renderer independently of Docker:

```sh
pnpm dev:table
# Open http://127.0.0.1:4313/dev/table/
```

For browser tests, install Playwright browsers first with `pnpm exec playwright install --with-deps`, then run `pnpm test:e2e`. PostgreSQL-backed tests require the Compose services. See [development environment](docs/dev-environment.md) for configuration, test users, ports, and database notes; see [table-2d](packages/table-2d/README.md) for the renderer harness.

## Build a game (planned workflow)

The target developer path is `bgp init → bgp dev → bgp validate → bgp build → bgp publish`. A game bundle will contain a deterministic rules definition, component declarations, and assets. Published versions will be immutable and addressed by their content hash, so matches and replays remain tied to the exact rules they used. The CLI and publishing flow are tracked in [T19](docs/tasks.md#t19-cli) and [T17](docs/tasks.md#t17-publish-create-match-invite); these commands are not available yet.

For the rules surface and data format, start with [rules API](docs/contracts/rules-api.md), [components and table](docs/contracts/components-and-table.md), and [manifest](docs/contracts/manifest.md).

## Project map

- [Intent](intent.md) — users, product journey, principles, and tie-breakers.
- [Phase 1 spec](docs/phase-1-spec.md) — scope and acceptance criteria.
- [Architecture](docs/architecture.md) — processes, package boundaries, and move flow.
- [Contracts](docs/contracts/) — source-of-truth interfaces for games, table, HTTP, and wire protocol.
- [Tasks and status](docs/tasks.md) — ordered implementation plan and validation links.
- [Decisions](docs/decisions.md) and [tech stack](docs/tech-stack.md) — accepted choices, defaults, and open questions.
- [Agent guide](AGENTS.md) — repository rules and contribution checks.

## Contributing

Follow [AGENTS.md](AGENTS.md) and pick up work from [docs/tasks.md](docs/tasks.md). Contract changes need matching schemas and tests. Keep game rules deterministic and pure, and preserve per-seat hidden information. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` for implementation changes; the relevant task's done checks may require more.

## License

[MIT](LICENSE).
