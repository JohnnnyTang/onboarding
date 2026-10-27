# Board Game Platform — Handoff

A web platform where indie designers build, playtest and later publish board games. Games are registered dynamically as SDK packages; the platform provides rendering, networking, accounts, storage and replays.

**Status:** T01 workspace scaffold; application features begin in T02. The package scope `@bgp/*` and the CLI name `bgp` are placeholders until the platform is named.

## Working with the scaffold

Use Node from `.nvmrc` and pnpm from `package.json#packageManager`, then run:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:wasm
pnpm exec playwright install chromium
pnpm test:e2e --project=chromium
```

All ten workspace packages currently export empty modules and have a placeholder test.
The browser test verifies the Playwright harness only; it does not claim a Phase 1 acceptance criterion.
`pnpm dev` runs scaffold watchers until API and web entry points arrive in T10/T12, and starts
Docker services automatically once T07 adds Compose. Database commands fail with an explicit T07
message until then. See [dev-environment.md](docs/dev-environment.md) for service configuration.

`pnpm lint` combines Biome with an AST-based package-boundary check. The guard also rejects
Node imports and known nondeterministic globals in pure source files. It supplements the
runtime isolation and determinism checks that later tasks must implement.

## Reading order

| #   | Document                                           | What it answers                                                                                     |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | [intent.md](intent.md)                             | Why this exists, who it is for, how to make judgment calls                                          |
| 2   | [AGENTS.md](AGENTS.md)                             | Rules for coding agents: commands, hard constraints, definition of done                             |
| 3   | [docs/phase-1-spec.md](docs/phase-1-spec.md)       | What Phase 1 delivers, acceptance criteria, what is out of scope                                    |
| 4   | [docs/architecture.md](docs/architecture.md)       | System shape, repo layout, package boundaries, how a move flows                                     |
| 5   | [docs/decisions.md](docs/decisions.md)             | Settled decisions (ADR log) and open questions                                                      |
| 6   | [docs/contracts/](docs/contracts/)                 | Source-of-truth interfaces: rules API, components and table, manifest, WebSocket protocol, HTTP API |
| 7   | [docs/data-model.md](docs/data-model.md)           | Database tables and storage keys                                                                    |
| 8   | [docs/reference-game.md](docs/reference-game.md)   | _Harbor Market_, the fully specified test game                                                      |
| 9   | [docs/tasks.md](docs/tasks.md)                     | Phase 1 broken into ordered tasks with done checks                                                  |
| 10  | [docs/testing.md](docs/testing.md)                 | Test strategy and quality gates                                                                     |
| 11  | [docs/dev-environment.md](docs/dev-environment.md) | Local setup, services, environment variables                                                        |
| 12  | [docs/tech-stack.md](docs/tech-stack.md)           | Libraries and tools by area and phase, version policy                                               |
| 13  | [docs/glossary.md](docs/glossary.md)               | Shared vocabulary                                                                                   |
| 14  | [docs/spikes/](docs/spikes/README.md)              | How open choices get settled with measurements; template and planned spikes                         |

## Relation to the earlier tech stack plan

The "Board Game Platform — Tech Stack Plan" document is the long-range picture. Where it differs from these files, **these files win**. These files add two things the plan lacks: a WebAssembly policy that explains each use (D-002), and a status for every library choice — accepted, default with alternatives, or open — with the stage at which open choices get decided ([decisions.md](docs/decisions.md#decision-points-by-stage), [tech-stack.md](docs/tech-stack.md)).

## Phases at a glance

| Phase | Name             | Delivers                                                                                                   | Gate to the next phase                            |
| ----- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1     | Designer sandbox | Rules runtime, 2D table, sandbox and enforced play, card generator, local-first projects, remote playtests | Designers keep coming back to playtest            |
| 2     | 3D table         | Three.js WebGPU renderer, quality tiers, material library, physics dice, asset pipeline                    | Standard tier runs smoothly on mid-range phones   |
| 3     | Balance evidence | Partial rules, AI-assisted rule drafting, bots, simulation, balance reports, board heatmaps                | Designers change their games based on the reports |
| 4     | Play center      | Public listing, matchmaking, async play, spectators                                                        | —                                                 |

Only Phase 1 is specified for implementation. Later phases appear where Phase 1 must leave room for them.

## License

This project is licensed under the [MIT License](LICENSE).
