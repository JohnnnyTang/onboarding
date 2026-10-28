# T05 validation

T05 implements `@bgp/testing` on `codex/t05-testing` in its own managed worktree.

## Delivered

- Seeded `runMatch` with bounded execution, explicit stop reasons, custom bots,
  detached step observers, accepted events and setup/per-move state hashes.
- `randomBot` selects uniformly from `legalMoves` with a separate PRNG. A test-only
  adapter enumerates sample sandbox operations without changing the runtime API.
- `checkDeterminism` checks setup and every accepted transition against a fresh
  replay, validates integer-only states and event order, and compares the public
  runtime replay result. Negative tests include intermediate divergence.
- `checkLeaks` checks each seat's `ClientView` and `TableSnapshot` using a trusted,
  game-specific visibility oracle. Tests cover hidden defs/values, missing backs,
  forged opaque IDs, nested secret strings/keys and IDs retired by a shuffle.
- Strict golden format parser and replay harness, with pinned tic-tac-toe and
  sample sandbox JSON fixtures. Tests enumerate all goldens and check identity,
  intermediate hashes, malformed recordings and rejected replay events.
- fast-check 4.10.2 is pinned as a development dependency; no runtime dependency
  or WASM inventory change. API behavior and oracle requirements are documented
  in [testing.md](testing.md).

## Checks

Run from the worktree with the existing healthy PostgreSQL/Keycloak local services:

| Check                                                    | Result                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                         | Passed before implementation; adding the pinned fast-check dev dependency updated the lockfile           |
| `pnpm build`                                             | Passed across all 10 packages                                                                            |
| `pnpm typecheck`                                         | Passed across the workspace and root scripts                                                             |
| `pnpm lint`                                              | Passed, including package-boundary checks                                                                |
| `pnpm test`                                              | Passed, including PostgreSQL/auth integration and rules-host isolation tests                             |
| `pnpm --filter @bgp/testing test`                        | 19 tests passed in five files                                                                            |
| `BGP_PROPERTY_RUNS=1000 pnpm --filter @bgp/testing test` | Passed; 1,000 cases each for tic-tac-toe/sandbox PROP-DET and UNIT-LEAK, 4,000 generated scenarios total |
| `pnpm check:wasm`                                        | Passed; only the existing server-side QuickJS module found                                               |
| `git diff --check`                                       | Passed                                                                                                   |

The environment variable syntax above is shell-neutral shorthand; in PowerShell
set `$env:BGP_PROPERTY_RUNS='1000'` before the package test command. The extended
property run took approximately 72 seconds on this machine. An earlier full-suite
run overlapped that extra CPU workload and exceeded the existing QuickJS allocation
test's 1.5-second wall-clock limit. The full suite passed after the property run
finished, with no isolation implementation or threshold changes.

## Scope

The T05 completion checks run PROP-DET and UNIT-LEAK against tic-tac-toe and a
three-seat sample sandbox, and demonstrate that deliberately leaky games fail.
The oracle must independently describe each game's hidden identities and opaque
ID provenance; it is not an inference engine or a proof against arbitrary secret
encodings. Authoritative traces and golden recordings are trusted developer test
artifacts, not client payloads.

Harbor Market, rules-host property coverage, real room-server leak checks and
cross-engine game-worker checks remain with their owning tasks. No UI or wire
protocol changes were needed for T05.
