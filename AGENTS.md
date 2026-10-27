# AGENTS.md

Instructions for coding agents working in this repository. Read [intent.md](intent.md) first, then [docs/phase-1-spec.md](docs/phase-1-spec.md). Pick up work from [docs/tasks.md](docs/tasks.md) in order unless told otherwise.

## Commands

| Command                        | What it does                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm install`                 | Install all workspace dependencies                                            |
| `pnpm dev`                     | Start local services (Docker), the API and room server, and the web app       |
| `pnpm build`                   | Build every package and app                                                   |
| `pnpm typecheck`               | TypeScript check across the workspace                                         |
| `pnpm lint`                    | Biome lint and format check                                                   |
| `pnpm format`                  | Biome format, writing changes                                                 |
| `pnpm test`                    | Unit and integration tests (Vitest)                                           |
| `pnpm test:e2e`                | Playwright end-to-end tests (needs `pnpm dev` running or uses its own server) |
| `pnpm db:generate`             | Generate a migration from the Drizzle schema                                  |
| `pnpm db:migrate`              | Apply migrations to the local database                                        |
| `pnpm --filter <pkg> <script>` | Run a script in one package                                                   |

Task T01 creates these scripts. Until then, they are the target.

## Hard rules

Breaking one of these is a blocking defect, even if tests pass.

1. **WebAssembly only through the inventory.** WASM-backed libraries are fine where [D-002](docs/decisions.md#d-002-webassembly-where-it-is-the-best-tool) lists them. Adding a new one means adding a row to the D-002 inventory and to `wasm-inventory.json` with its reason and fallback, in the same change; CI fails otherwise. Wrap each one behind our own interface, load it lazily and self-host the `.wasm` file. Do not write our own WASM modules.
2. **Rules code is pure.** `@bgp/rules`, `@bgp/schema` and all game code must not use the DOM, Node APIs, `Date`, `Math.random`, timers, network or storage. Randomness comes only from `ctx.random`. Authoritative state holds only JSON values with integers, strings, booleans, arrays, objects and `null` — no floats, no `undefined`, no `Map`/`Set`.
3. **The server is authoritative and never leaks.** Clients receive only the output of `playerView` (enforced games) or the runtime's sandbox view. Never send full match state, the RNG state or another seat's hidden data to a client, including in error messages and logs sent to clients.
4. **Contracts are the source of truth.** Interfaces in [docs/contracts/](docs/contracts/) define the code. If you need to change one, update the contract doc, the Zod schema and the tests in the same change. Breaking changes bump `schemaVersion` (manifest) or `PROTOCOL_VERSION` (wire protocol).
5. **Boundaries hold.** Follow the import rules in [docs/architecture.md](docs/architecture.md#package-boundaries). Game code never imports a renderer; renderers never import a specific game.
6. **Units are fixed.** Millimeters, degrees, grams. Positions and rotations in match state and snapshots are whole numbers; declared component sizes may have decimals. Table coordinates follow [docs/contracts/components-and-table.md](docs/contracts/components-and-table.md#coordinates).
7. **Dependencies are deliberate.** Prefer platform APIs and the libraries already listed in [docs/tech-stack.md](docs/tech-stack.md). Every new runtime dependency gets a row there with its reason. Where tech-stack.md marks a choice **Default** or **Open**, use the listed default and keep it behind the named interface; do not switch to an alternative on your own. If a default causes real problems, record the evidence in the open questions of decisions.md and ask.
8. **TypeScript is strict.** `strict: true`, no `any` in exported types, no non-null assertions on data that crosses a trust boundary (network, storage, game code). Validate untrusted input with the Zod schemas from `@bgp/schema`.

## Conventions

- Language: TypeScript everywhere, ES modules, Node active LTS.
- Formatting and lint: Biome with the repo config. Do not add ESLint or Prettier.
- Naming: files `kebab-case.ts`, types `PascalCase`, functions and variables `camelCase`, constants `SCREAMING_SNAKE_CASE`.
- Errors crossing the wire use the codes in [docs/contracts/protocol.md](docs/contracts/protocol.md#error-codes). Do not invent new codes without adding them there.
- Commits: Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`), one task ID in the body (`Task: T07`).
- Keep functions small and code boring. No clever metaprogramming in the rules runtime; it must stay easy to audit.

## Definition of done (every task)

- The task's "Done when" checks in [docs/tasks.md](docs/tasks.md) pass.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- New behavior has tests; rules runtime changes include determinism tests.
- Contract changes are reflected in the docs.
- No new dependency without a row in tech-stack.md; no WASM module outside the D-002 inventory.

## When something is unclear

1. Check [intent.md](intent.md) — its tie-breakers decide most questions.
2. Check [docs/decisions.md](docs/decisions.md).
3. If still unclear, choose the most reversible option, implement it behind a small interface, and add the question to the **Open questions** section of decisions.md with what you chose and why.

Never weaken hidden-information handling, determinism or isolation of game code to get unblocked. Stop and ask instead.

## Spikes

Some tasks start with a time-boxed spike that settles an open choice (T08 sandbox, T13 2D renderer). A spike produces: a short write-up in `docs/spikes/<task>-<topic>.md` with the options tried, the numbers measured against the criteria in decisions.md, and a recommendation; then a status change in decisions.md once a human agrees. Spike code may be thrown away.
