# T06 Harbor Market validation

Implemented on `codex/t06-harbor-market` in an isolated managed worktree.

## Delivered

- Complete 2–4 seat enforced game: normal/short setup, opaque card IDs, seeded
  shuffle and tide rolls, swap/ship/restock/pass, discard phase, round completion,
  scoring and harbor-count tie-breaks.
- Filtered seat and spectator views; legal move enumeration; table snapshots,
  drag-to-swap interpretation and selection-aware action buttons.
- Manifest and 17 component definitions. Art paths intentionally await T16.
- An import-free `dist/game.js` default export under the 2 MB bundle limit.
  Marking the pure rules package side-effect-free prevents unused Immer/Node
  environment initialization from entering SDK-only game bundles. The bundle
  is exercised in QuickJS, with per-step Node hash/view parity.
- Optional `ZonePlacement.rotation_deg` in the contract, Zod schema and generated
  JSON schemas. Renderer layout, labels, hit-testing and drop indices rotate
  together. Existing unrotated Chromium screenshot baselines still pass.
- Narrow game-test-only access to `@bgp/testing` and schema validators. Production
  game imports remain limited to rules SDK helpers and schema types.

## Coverage

The focused tests cover every required reference-game scenario and game error
code, malformed/duplicate IDs, legal subset enumeration, private/spectator views,
2/3/4-seat layouts, invalid gestures and selection, and inactive/finished controls.

The property suites use fast-check seeds 606 and 607, independent match/bot seeds,
2–4 seats and both game lengths. Every run must finish within 2,000 accepted moves;
a truncated run fails. Replay checks compare setup and every subsequent state hash,
including the RNG state, then exercise the runtime's public replay function. Card
conservation checks account for all 45 cards (including the short-game box).

Leak checks examine every seat at setup and after every accepted move, scanning
both client views and table snapshots for every hidden hand/deck/box ID. An
independent oracle verifies count-derived placeholder provenance and visible
component identity. Spectator filtering and enabled action validity are checked
at every step too. Local defaults are 20 games per property; the full workload
uses 1,000 deterministic games and 200 hidden-information games.

## Acceptance run

The full workload ran on `209bdd4` (2026-10-29, Windows, Node 24.12.0) with
`BGP_PROPERTY_RUNS=1000`: 3 files and 28 tests passed. PROP-DET verified 1,000
deterministic games (895 s) and UNIT-LEAK verified 200 hidden-information games
(184 s). Later commits on the branch and the merges into main change no game or
rules runtime code. After the merges, typecheck, lint, workspace tests with
PostgreSQL, build, WASM inventory and generated schemas pass, and the table-2d
and Harbor Market e2e specs pass in Chromium, Firefox and WebKit.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:wasm
pnpm json-schema
BGP_PROPERTY_RUNS=1000 pnpm --filter harbor-market test
pnpm test:e2e e2e/table-2d.spec.ts e2e/harbor-market.spec.ts --project=chromium
```

On PowerShell, set `$env:BGP_PROPERTY_RUNS = '1000'` before the game test command,
then remove that environment variable afterwards. Local validation used Windows,
Node 24.12.0 and pnpm 11.9.0, with PostgreSQL/Keycloak services available for
integration tests.

## Scope limits

T16 supplies the referenced images before upload finalization can succeed. T08's
Harbor Market performance/memory benchmark and human confirmation of D-008 remain
separate gates; the QuickJS parity test is functional evidence, not a benchmark.
Remote room-server play and the browser game-worker replay matrix belong to their
later tasks. Numbered HUD/waiting labels are the reversible SDK 1 fallback recorded
in Q-012 until presentation receives a display-name mapping.

Follow-up: the four harbor zones overlap at the table corners. Since the renderer
keeps zone labels upright in the viewer's top-left corner, two harbor labels share
a corner (for example seat 2 and seat 3 from seat 1's view). Shrinking or offsetting
the side harbors in `presentation.ts` would fix it; table polish can pick this up
in T15/T20.
