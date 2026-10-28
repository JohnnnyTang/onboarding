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

`parseGoldenReplay(unknown)` validates the exact fields using the shared contract
validators: game slug, SHA-256 build/hash strings, match init, contiguous accepted
events from participating seats, and at least one hash at a canonical decimal
sequence between 0 and the final event. Sequence 0 means setup. Sparse checkpoints
and setup-only recordings are supported.

`checkGoldenReplay(def, fixture, { game, buildHash })` checks the caller's pinned
game/build identity, replays all events, compares every recorded checkpoint and
returns the final state. Callers load JSON themselves, allowing the harness to
run without filesystem APIs. Tests enumerate every committed golden file and fail
on an unregistered game. Initial T05 fixtures cover tic-tac-toe and sample sandbox;
their build identifier is the SHA-256 of the test definitions when recorded. They
are test fixtures, not published game versions. Tests never rewrite recordings.

## Random bot

`@bgp/testing` exports `randomBot(def, state, seat, random)`, which picks uniformly from `legalMoves`. It drives property tests, `bgp validate` and performance scripts. It is a test tool, not a product feature.

`state` is a full `MatchState`. The bot returns `null` when the seat has no legal
moves or the match has finished; missing `legalMoves` is an error. A sandbox has
no built-in move enumeration, so callers supply a custom bot or wrap its
definition with a bounded `legalMoves` adapter. Bot randomness uses its own seeded
RNG and never consumes the match RNG.

`runMatch(def, init, { maxMoves?, botSeed?, bot?, onStep? })` returns the init,
accepted events, setup and per-event state/hash trace, and a stop reason:
`finished`, `no-legal-moves`, or `move-limit` (default limit: 1,000 moves).
The runner tries the current seat then other seats to support simultaneous and
`anySeat` moves. A bot proposing a rejected move fails the run. `onStep` runs on
setup and each accepted move with detached state; it can attach game-specific
assertions. Traces contain authoritative state and are trusted test artifacts.

`checkDeterminism(def, run)` recreates setup and compares the recorded hash at
every step, then checks the public runtime `replay` result. It validates the
integer-only states and contiguous event sequence. Comparing the initial and
intermediate hashes catches divergence even when final states converge.

## Reusable leak checks

`checkLeaks(def, state, { components, oracle })` runs `viewFor` and `present` for
every participating seat. Attach it to `runMatch`'s `onStep` to check setup and
every move. The trusted `oracle(state, seat)` receives detached authoritative
state and returns independently derived knowledge:

- `forbiddenStrings`: identities/secret markers and retired opaque IDs that must
  not appear in any output string or property name, including embedded text.
- `canIdentify(id)`: whether the seat may identify this instance.
- `isOpaqueId(id)`: verify a hidden ID's provenance against authoritative state
  or an independent registry. A matching regular expression alone is insufficient.
- `isCard(id)`: whether the instance is a card, so hidden cards require a back.

The checker validates snapshots against `tableSnapshotForSeatSchema`, rejects
`def` and die values on hidden items, checks hidden IDs, and scans both outputs
recursively. It also checks item-like `{ id, zone, ... }` objects in arbitrary
`ClientView.game` JSON, even if presentation later strips their `def`. Failure
messages identify the sequence, seat and output without echoing secrets.

The oracle is necessary: an arbitrary game's hidden data cannot be inferred from
its JSON shape. It must describe that game's secrets independently of the code
under test. Use unique secret markers and enough forbidden strings to cover its
view representation; these checks do not prove noninterference or detect arbitrary
encodings. Shared component defs may be public elsewhere while their hidden
instances still must omit `def`. Opaque instance IDs can appear on hidden items;
IDs replaced by a shuffle must disappear everywhere. Track retired IDs across
steps and add them to `forbiddenStrings`, as in the sample sandbox property test.

T05 runs PROP-DET and UNIT-LEAK against tic-tac-toe and a three-seat sample sandbox
with fast-check. `BGP_PROPERTY_RUNS` controls each property's run count (20 locally,
1,000 nightly). Deliberately leaky fixtures exercise both view and presentation
failures. Rules-host and Harbor Market coverage belongs to T08/T06; these headless
checks do not replace INT-LEAK or isolation tests.

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

1. Install with a frozen lockfile.
2. `pnpm lint`, `pnpm typecheck`.
3. CI-WASM-INVENTORY.
4. `pnpm test` (unit, property with bounded runs, integration with Docker services).
5. `pnpm test:e2e` on Chromium.
6. Nightly: full browser matrix, 1,000-game PROP-DET, PERF-01, PRNG distribution.
