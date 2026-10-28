# Testing

Tests guard the three properties that must never break: **hidden information**, **determinism**, and **isolation of game code**. Everything else is ordinary product testing.

## Layers

| Layer       | Tool                                              | Where                            | Runs                                              |
| ----------- | ------------------------------------------------- | -------------------------------- | ------------------------------------------------- |
| Unit        | Vitest                                            | Next to code, `*.test.ts`        | Every commit                                      |
| Property    | Vitest + fast-check                               | `packages/*/test/*.prop.test.ts` | Every commit (bounded runs); long runs nightly    |
| Integration | Vitest, real PostgreSQL (Docker), real rules host | `apps/server/test/`              | Every commit                                      |
| End-to-end  | Playwright, multiple browser contexts             | `e2e/` at repo root              | Chromium on every PR; full browser matrix nightly |
| Performance | Node load script                                  | `scripts/perf/`                  | Nightly and before handoff                        |

## Named tests (referenced by acceptance criteria)

| ID                | What it does                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UNIT-LEAK         | For Harbor Market and a sample sandbox game, generates random games and, at every step, checks each seat's `ClientView` and `TableSnapshot`: no identity of a hidden card (deck, box, other hands, face-down items), and no `def` on items the seat may not identify.                                                                                                   |
| INT-LEAK          | Runs a 3-seat match through the real room server with spy connections; asserts every `welcome`, `patch` and `snapshot` sent to each seat, after applying patches, equals that seat's `playerView` and contains no hidden IDs.                                                                                                                                           |
| PROP-DET          | fast-check generates seeds and random legal move sequences (from `legalMoves`) for Harbor Market and sandbox games; asserts `replay(seed, events)` gives the same state hash at every step, both in Node directly and inside the rules host's sandbox, and that the integer-only check never fails. 1,000 games in the nightly run.                                     |
| INT-REPLAY        | Plays a match to the end through the server, then rebuilds it from `match_events`; final hash equals the stored snapshot's hash.                                                                                                                                                                                                                                        |
| INT-UPLOAD        | Uploads a version, finalizes it, re-uploads identical files as a new version: same build hash. Corrupt hash, missing asset, `.wasm` file, SVG image, bundle with an `import` statement: each rejected with `VALIDATION_FAILED` and a specific error.                                                                                                                    |
| INT-ISOLATION     | Loads hostile test bundles: infinite loop in a move; allocation loop; access to `fetch`, `process`, `require`, `globalThis.constructor`, `import()`; `Date.now()` and `Math.random()`. Each yields `GAME_ERROR` or a failed finalize; other matches keep running; the server process stays up. The same suite runs against every sandbox option tried in the T08 spike. |
| INT-RECOVERY      | Kills the rules host process mid-match; the server restarts it; the match continues with the same state hash; clients receive a `snapshot`.                                                                                                                                                                                                                             |
| PERF-01           | 20 concurrent Harbor Market matches with scripted clients; records move round-trip latency; fails if p95 ≥ 200 ms.                                                                                                                                                                                                                                                      |
| CI-WASM-INVENTORY | Scans build outputs and the production dependency tree (`pnpm list --prod --depth Infinity` plus a file scan) for `.wasm` files. Fails if any file is not matched by an entry in `wasm-inventory.json`, if an entry has no matching D-002 row, or if a module listed as server-only appears in the web app's build. Prints the size of every module found.              |
| E2E-01            | Offline project: create, import images, generate cards from template + CSV, declare zones and setup, hot-seat play.                                                                                                                                                                                                                                                     |
| E2E-02            | Sign in (Keycloak test user), publish the project, see the version ready.                                                                                                                                                                                                                                                                                               |
| E2E-03            | Owner plus two guests in separate contexts; sandbox play with move, flip, shuffle, deal, roll; each change visible to the others.                                                                                                                                                                                                                                       |
| E2E-04            | 4-seat Harbor Market to completion with scripted moves, including one illegal move showing its message, and the result screen.                                                                                                                                                                                                                                          |
| E2E-05            | Reload mid-match: same seat and current view within 3 seconds.                                                                                                                                                                                                                                                                                                          |
| E2E-06            | In each browser of the matrix, replay a recorded game fixture in the game worker and compare the final state hash with the rules host's result (QuickJS by default). This is the cross-engine determinism check.                                                                                                                                                        |
| E2E-07            | CLI flow in a temporary directory: `bgp init`, `bgp validate`, `bgp build`, `bgp publish` against the local server.                                                                                                                                                                                                                                                     |

## Golden replays

`packages/testing/golden/*.json` hold recorded matches: `{ game, buildHash, seats, seed, options, events, expectedHashes: { "<seq>": "<hash>" } }`. A test replays each and checks the hashes at the recorded steps. Add a golden file for every bug fixed in the runtime. Regenerating golden files is allowed only when a contract version changes, and the change must say so.

## Random bot

`@bgp/testing` exports `randomBot(def, state, seat, random)`, which picks uniformly from `legalMoves`. It drives property tests, `bgp validate` and performance scripts. It is a test tool, not a product feature.

## Coverage expectations

- `@bgp/rules`: every branch of the order of operations in `applyIntent`, every sandbox operation, PRNG and shuffle distribution sanity (chi-squared on 100,000 draws, nightly).
- `@bgp/schema`: every schema accepts its documented examples and rejects each documented violation.
- Room server: each error code in [contracts/protocol.md](contracts/protocol.md#error-codes) is produced by at least one test.

## CI pipeline

T01 implements the pipeline in `.github/workflows/ci.yml`. It builds before the WASM scan
so emitted binaries are included. Contract export and Docker integration services are enabled.
CI checks Drizzle migration metadata and schema drift before starting the services. Server
tests migrate the test database automatically and fail if PostgreSQL is unavailable;
browser tests verify local Keycloak login. PERF-01 remains conditional until T20.
Packages without implementations still have scaffold tests.

T03 adds `e2e/rules.spec.ts`, which loads the compiled runtime and the installed
dependencies as ESM through Playwright request routing. It compares Node and browser
hashes at every step of a seeded random game and its replay, inserts rejected random
draws to verify rollback, and plays tic-tac-toe to a win. The test uses Immer's production
ESM artifact, which requires no Node globals. Run `pnpm build` before standalone browser
tests; CI builds the runtime before its browser checks. These are headless core checks,
not the full game-worker and Harbor Market E2E-06 acceptance test due in later tasks.

The nightly job sets `BGP_PROPERTY_RUNS=1000` and `BGP_PRNG_DRAWS=100000`; property and
distribution suites must read these settings when implemented. It runs the Chromium,
Firefox and WebKit matrix, while push and pull-request jobs run Chromium.

T13 adds real table renderer interactions and screenshots at 360/1440 px. Windows
baselines are enforced in the `table-visuals` job across Chromium, Firefox and
WebKit. Linux jobs keep the interaction matrix and pass `--ignore-snapshots` to
avoid comparing Windows font/GPU rasterization on Linux. Review every changed
PNG before accepting `--update-snapshots`. The fixture server starts automatically
through Playwright and needs neither Docker nor the T12 app shell.

Physical Android/iPhone renderer profiling is a T20 gate, deferred from T13 by
the project owner on 2026-10-27. Run both the three-engine spike and production
`/dev/table/?stress=1` on identified hardware. Record 300-item frame cadence
against the 60 fps target, DPR/backend, readable text after zooming and actual
touch drag/drop, pinch/pan, seat rotation and viewport resizing. Desktop WebKit
and synthetic touch events do not establish AC-12 on iOS or Android.

1. Install with a frozen lockfile.
2. `pnpm lint`, `pnpm typecheck`.
3. CI-WASM-INVENTORY.
4. `pnpm test` (unit, property with bounded runs, integration with Docker services).
5. `pnpm test:e2e` on Chromium.
6. Nightly: full browser matrix, 1,000-game PROP-DET, PERF-01, PRNG distribution.
