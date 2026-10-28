# T04 validation

Validated locally on 2026-10-27 in the managed T04 worktree on Windows.

## Delivered

- createSandboxDefinition builds a deterministic manual game from validated component,
  zone and setup declarations. Each-owned zones expand in seat order; setup supports
  counts, faces and one final shuffle per flagged zone.
- All seven operations: move, flip, rotate, shuffle, deal, roll and endTurn.
  Source-zone ownership, references, insertion indices, coordinates, die kinds and
  available deal counts are checked before mutation. Rejections preserve state and RNG.
- Every participating seat can act independently of the HUD turn. Giving items into
  another seat's owner zone is allowed; manipulating its contents is rejected.
- SandboxView and its schema expose only allowed item fields. Views omit hidden
  identities and die values, show hidden card backs, and exclude RNG state.
  present produces integer table snapshots, all five layouts, interaction flags and HUD.
- Shuffles replace every instance ID and canonicalize item array order. Rotation and
  free-position marks reset to zero so old visual marks cannot identify fresh IDs.
- Move parsers accept an optional detached state/context/seat snapshot for validation
  that must return INVALID_ARGS. Existing one-argument parsers remain compatible.
  The contract, validator, generated JSON Schema and isolation regression test agree.
- No new dependency or WASM module.

## Checks

| Check                                       | Result                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile              | Pass                                                                          |
| pnpm typecheck                              | Pass across all packages and tooling                                          |
| pnpm lint                                   | Pass, including package boundaries                                            |
| pnpm test                                   | Pass: 87 rules, 135 schema, 40 other package and 45 tooling tests (307 total) |
| pnpm build                                  | Pass: all 10 packages                                                         |
| pnpm check:wasm                             | Pass: 0 modules                                                               |
| pnpm --filter @bgp/schema json-schema       | Pass: 111 exported schemas                                                    |
| pnpm exec playwright test e2e/rules.spec.ts | Pass: existing rules regressions in Chromium, Firefox and WebKit              |

The 14 sandbox tests cover all operations, malformed input and state-dependent
rejections, contiguous indices, round-robin deals, own/other/spectator visibility,
private face-up items, die values, fresh shuffle IDs, tracking marks, declaration
detachment, setup shuffles, zone expansion, fixed owners, and table bounds.
A mixed trace with every manual operation compares replayed state hashes at every
accepted event across 20 seeds (500 prefix comparisons). Existing PostgreSQL
integration tests also passed against the healthy local services.

## Scope and reversible defaults

The components/table contract and Q-009 record the minimum 800 by 600 mm table
(expanded to enclose declarations), overlapping each-owned rectangles, setup defaults,
top-first dealing with count per target, and shuffle tracking-mark removal.
Future authoring work may revisit these defaults without weakening visibility.

The public sandbox view and parser context schemas are additive. No manifest or
wire-protocol shape changed; existing schemaVersion and PROTOCOL_VERSION remain valid.
The browser run checks the existing core runtime regressions; it does not claim
browser sandbox integration, the T05 reusable leak/property harness, the T08 rules
host or the T14 worker/match page. T08 and T09 remain separate worktree tasks.
