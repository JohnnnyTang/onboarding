# T03 validation

Validated locally on 2026-10-27 on Windows with Node 24.12.0 and pnpm 11.9.0.

## Delivered

- Integer sfc32 with fixed seed expansion and compatibility vectors; inclusive,
  unbiased integer sampling, dice, picks, Fisher–Yates shuffle and opaque IDs.
- Integer-only canonical JSON with lexically sorted keys, preserved arbitrary keys
  and UTF-8 SHA-256 via Web Crypto. Production sources import no Node or DOM API.
  The boundary guard admits only `crypto.subtle.digest("SHA-256", ...)` in `hash.ts`;
  entropy APIs and other pure-module access remain forbidden.
- `createMatch`, `applyIntent`, `viewFor` and `replay`, plus `invalid`, `defineGame`,
  `rekey`, `countHidden` and `seatsAfter`. Match lifecycle hooks and event composition
  follow the rules contract, including rollback of state, RNG draws and events.
- Detached contexts, inputs and views prevent callback/caller references from changing
  authoritative state. Views contain only `playerView`, public context and result.
  Unexpected game errors return fixed messages without exception text or stacks.
- Immer 11.2.9 is pinned in the package/lockfile and recorded in tech-stack.md.
  No WASM module or additional runtime dependency was added.
- A tiny tic-tac-toe test game and a seeded random test game. All seven rejection
  codes, all sixteen event combinations, hook failures, invalid state and event
  inputs, turn order, initialization, win/draw and replay sequencing are tested.

## Checks

| Check                            | Result                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Pass                                                                         |
| `pnpm typecheck`                 | Pass across the workspace and tooling                                        |
| `pnpm lint`                      | Pass, including package boundaries                                           |
| `pnpm test`                      | Pass: 72 rules, 133 schema, 8 other package and 44 tooling/contract tests    |
| `pnpm build`                     | Pass: all 10 packages                                                        |
| `pnpm check:wasm`                | Pass: 0 modules                                                              |
| `pnpm json-schema`               | Pass: 109 files, no generated schema changes                                 |
| Browser tests                    | Pass: 6 tests across Chromium, Firefox and WebKit                            |
| Nightly-size rules run           | Pass: `BGP_PROPERTY_RUNS=1000`, `BGP_PRNG_DRAWS=100000`; 72 tests in 84.62 s |

The nightly-size test replays every prefix for 1,000 random tic-tac-toe games and
1,000 seeded random-game sequences, comparing every state hash and checking random
rollback. Dice and shuffled-item positions each pass a chi-squared distribution
sanity check with 100,000 draws. The bounded default uses 20 seeds and 6,000 draws.

Browser tests compare 21 Node/browser hashes and every replay prefix, including
non-ASCII text, numeric-looking object keys, wide integer draws, shuffles and IDs.
Chromium/WebKit passed together; Firefox passed separately outside the Windows
sandbox after the sandbox prevented browser launch. The WASM scan and frozen
install also ran outside the sandbox because pnpm's user SQLite cache was blocked.
These are local results, not a claim about remote CI.

## Scope and open choices

The contract now states previously unspecified behavior for omitted arguments,
repeated event calls, hook-generated events, initialization events and callback
snapshots. Q-007 records the reversible event default: last call per kind in each
ordered batch, hook events in subsequent batches, and a 128-call transaction limit.
No serialized contract shape changed, so schemas and protocol/manifest versions
remain unchanged.

This is the headless runtime core. T04 adds sandbox operations; T05 adds the reusable
property/leak-checking harness; T06 adds Harbor Market. T08 supplies execution
deadlines and isolation of hostile code, and T14 supplies the actual browser worker.
The browser checks here do not claim completion of those later acceptance criteria.
