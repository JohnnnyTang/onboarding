# T13 table renderer validation

Implementation and desktop validation are complete. The renderer recommendation
is PixiJS 8.6.6 behind `TableRenderer`; human confirmation of D-009 is the only
remaining T13 gate. The project owner deferred physical-phone qualification to
T20 on 2026-10-27. This is a scheduling change, not a physical-device pass.

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
- PixiJS 8.6.6 is pinned to avoid optional WASM files in newer inspected versions.
  All dependencies and development tools are recorded in `tech-stack.md`.

## Worktree validation (2026-10-27)

Branch: `codex/t13-renderer-validation`, based on `b40f329`. Local environment:
Windows, Intel Arc 140V / driver 32.0.101.8860, Node 24.12.0, pnpm 11.9.0,
Playwright 1.64.1. Timestamps in the raw evidence are UTC; the local date is
October 27 in America/New_York.

| Check                                            | Result                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                 | Pass                                                               |
| `pnpm lint`                                      | Pass, including package boundaries                                 |
| `pnpm typecheck`                                 | Pass across the workspace and development harness                  |
| `pnpm test`                                      | Pass, 359 tests including 14 layout/drop tests                     |
| `pnpm build`                                     | Pass, all 10 packages/apps                                         |
| `pnpm build:table-dev`                           | Pass; fixture bundle in `.scratch/table-dev/`                      |
| `pnpm check:wasm`                                | Pass; only the inventoried server-side QuickJS module, no web WASM |
| `pnpm test:e2e e2e/table-2d.spec.ts --workers=1` | Pass, 18 tests across Chromium/Firefox/WebKit                      |
| Headed/headless Chromium spike                   | Pass, 12 measurements, no page errors                              |
| Invalid spike `--browser`                        | Rejected before browser launch                                     |

The first concurrent workspace test run hit two existing rules-host timing
failures (VM startup and QuickJS allocation). A subsequent unmodified `pnpm test`
run passed all 359 tests. No rules-host code, limits or tests were changed.

The table suite has six tests per browser and 24 reviewed PNG baselines:
360/1440 px table fit and 300-item stress fixtures, drag feedback, seat-1 rotation,
the next authoritative snapshot, and mobile pinch/pan. Existing baselines passed
without regeneration; representative table and stress images were inspected.
The suite checks contract-valid click/zone/drop payloads, integer coordinates
after camera transforms, return after unconfirmed drops, repeated transitions,
hidden-back-only asset resolution, selection pruning/unsubscription, repeated
destruction/remount and page errors. Synthetic touch PointerEvents exercise the
common input path across engines; physical touch qualification belongs to T20.

Screenshot comparisons permit at most 100 differing pixels. Windows CI owns the
visual baselines; Linux runs interactions without comparing Windows rasterization.
The Windows CI job is configured but was not run remotely from this worktree.

## Spike evidence and recommendation

The [spike report](spikes/t13-renderer-2d.md) and
[original measurements](spikes/t13-renderer-2d-results.json) compare PixiJS,
Three.js orthographic and Canvas 2D at 300 items across all three browsers.
The [Chromium follow-up](spikes/t13-renderer-2d-chromium-results.json) separates
headed Intel D3D11 from headless SwiftShader. Pixi frame p95 is 8.4 ms at both
360 and 1440 px on the accelerated desktop; headless p95 is 33.4/116.7 ms.
The backend comparison explains why the earlier software-rendered cadence
should not be read as a measured phone or hardware-GPU regression.

Confirm PixiJS 8.6.6 for Phase 1, retaining `TableRenderer` as the adapter boundary
and Canvas as an alternative. Desktop screenshots cover text and zoomed detail;
this evidence does not establish phone text readability or 60 fps on a phone.

## Deferred physical-device qualification: T20

The project owner's 2026-10-27 instruction moves real-phone tests out of T13's
gates. `tasks.md`, `testing.md` and D-009 now carry that follow-up explicitly:

- Profile the three-engine fixture and production `/dev/table/?stress=1` on
  identified mid-range Android and iPhone devices with 300 draggable items.
- Record model, OS/browser version, DPR, graphics backend where exposed, and
  p50/p95 frame intervals against the 60 fps target.
- Check text at fit/zoom, real-touch drag/drop, pinch/pan, seat rotation and
  viewport resizing from 360 px upwards. AC-12 remains a T20 acceptance gate.

No contract, determinism, hidden-information, isolation or WASM rule was relaxed.

## Integration history

The renderer was developed on `codex/t13-table-2d`, based on `39259b7`, and merged
into `main` with T03/T07. The 2026-10-27 integration review preserved dependency
pins, database drift checks, browser determinism and Windows visuals. It fixed
sparse grids collapsing empty cells with two regression tests. At that point all
33 browser tests passed, including runtime hashes and Keycloak account/PKCE tests;
no visual baselines or generated contract schemas changed during integration.
