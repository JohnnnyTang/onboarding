# T13 validation and remaining acceptance gate

The renderer implementation was developed on `codex/t13-table-2d`, based on
`39259b7`, and integrated into `main` with T03 and T07 after review. T13 uses the
completed T02 contracts and remains independent of the app shell.

## Scope

- `PixiTableRenderer` implements the existing generic renderer contract without
  changing schemas, wire messages or authoritative state.
- Stacks, rows, fans, grids and free zones; images, explicit card backs, missing
  art labels, die faces, token shapes, boards/pieces, badges and highlights.
- Selection, gesture subscriptions, droppable-zone feedback, ID-matched animated
  transitions, seat camera rotation, touch pinch/pan and wheel zoom.
- Drops return to the snapshot position while waiting for authoritative updates;
  no speculative match-state change. Only visible art or explicit backs load.
- A standalone `/dev/table/` fixture route and three-engine spike harness run
  with `pnpm dev:table`. The T12 shell can reuse the renderer later.
- PixiJS 8.6.6 is pinned to avoid optional WASM files in newer inspected versions;
  the production dependency scan finds no WASM modules. All added dependencies
  and development tools are recorded in `tech-stack.md`.

## Validation

Local environment: Windows, Node 24.12.0, pnpm 11.9.0, Playwright 1.64.1.

| Check                       | Result                                                    |
| --------------------------- | --------------------------------------------------------- |
| `pnpm lint`                 | Pass, including package boundaries                        |
| `pnpm typecheck`            | Pass across the workspace and development harness         |
| `pnpm test`                 | Pass, including 12 table layout/drop tests                |
| `pnpm build`                | Pass across all 10 packages/apps                          |
| `pnpm build:table-dev`      | Pass; inspectable fixture bundle in `.scratch/table-dev/` |
| `pnpm check:wasm`           | Pass, zero production modules                             |
| `pnpm test:e2e --workers=1` | Pass, Chromium/Firefox/WebKit matrix                      |

The table suite has six tests per browser and 24 reviewed PNG baselines:
360/1440 px table fit and 300-item stress fixtures, drag feedback, seat-1 rotation, the next authoritative
snapshot, and mobile pinch/pan. It checks contract-valid click/zone/drop payloads,
integer drop coordinates after camera transforms, return after unconfirmed
drops, repeated snapshot transitions, hidden-back-only asset resolution,
selection pruning/unsubscription, repeated destruction/remount and page errors.
Synthetic touch PointerEvents exercise the common input path on every engine;
physical touch hardware remains part of the phone qualification below.

Screenshot comparisons permit at most 100 differing pixels. Windows CI owns the
visual baselines; Linux runs interactions without comparing Windows rasterization.
The Windows CI job is configured but has not been run remotely from this worktree.

## Remaining acceptance gate

T13 is **not marked Complete**. The [spike report](spikes/t13-renderer-2d.md) and
[raw measurements](spikes/t13-renderer-2d-results.json) compare all three renderers
at 300 items. These desktop headless measurements do not prove 60 fps on a
mid-range phone. Chromium reports SwiftShader software rendering; do not treat
its timings as accelerated phone results. Physical Android/iOS profiling and
human confirmation of D-009 are still required by the task and AGENTS.md.
Pixi remains the reversible existing Default, with no new accepted decision.

No contract, determinism, hidden-information or WASM rule was relaxed to finish
the implementation.

## Integration review (2026-10-27)

- Preserved both branches' dependency pins and CI checks, including database
  migration drift checks, runtime browser determinism and Windows table visuals.
- Kept the runtime event question as Q-007 and numbered the renderer confirmation
  question Q-008. D-009 remains Default, and T13's acceptance gate stays open.
- Fixed grid layouts collapsing empty cells: a piece with index 3 now stays in
  cell 3. Rendering and drop hit testing share inferred grid dimensions. Two
  regression tests cover sparse declared and inferred grids; 14 layout tests pass.
- Combined workspace lint, typecheck, tests (290 total), all 10 builds, fixture
  build and WASM inventory pass. Contract generation produces no schema changes.
- T07 migrations apply successfully, migration metadata checks pass and generation
  finds no database schema drift. Real PostgreSQL integration tests pass.
- All 33 browser tests pass across Chromium, Firefox and WebKit, including existing
  screenshot baselines, Node/browser runtime hashes and Keycloak account/PKCE tests.
  No screenshots or generated contract schemas were changed during integration.
