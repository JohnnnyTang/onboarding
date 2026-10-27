# T08 server sandbox comparison

Status: fixture comparison complete; Harbor Market benchmark and human confirmation
pending. D-008 remains **Default**. This is an intermediate spike report, not a
claim that T08 or AC-09 is complete.

## Scope and reproduction

Starting revision: `cba6a6c`. Harbor Market is an empty scaffold at this revision,
so it cannot supply the D-008 acceptance workload yet. Both implementations run
the actual bundled `@bgp/rules` runtime, Zod schemas and Immer with the same small
two-seat game. Setup draws a hidden random ID; each legal move draws a seeded die;
views exclude that ID. The fixture is not a performance proxy for Harbor Market.

Measured on Windows x64, Intel Core Ultra 7 258V, Node v24.12.0 (within the repo's
engines range, older than `.nvmrc`), QuickJS core/release-sync 0.32.0. Raw measurements,
including timestamps and all hostile-call times, are in
[t08-sandbox-results.json](t08-sandbox-results.json).

```sh
pnpm install --frozen-lockfile
pnpm --filter @bgp/rules-host... build
pnpm --filter @bgp/rules-host test
pnpm exec vitest run scripts/t08-determinism.test.ts
pnpm exec tsx scripts/t08-sandbox.ts
```

The measurement script records the first cold load, then 20 warm load-and-create
samples while keeping 21 matches alive. It measures 500 moves and compares every
state hash with direct Node runtime execution. Reported percentiles use nearest
rank; fixture move measurements include JSON copying and output validation. VM
move times also include IPC. The QuickJS move times exclude production IPC, which
has not been implemented yet. Measurements are sequential, not a concurrency load test.

## Options tried

QuickJS uses one interpreter runtime per match in one Node process, with a separate
heap, 64 MiB memory limit, 512 KiB stack cap and a 1000 ms interrupt handler. The
trusted runtime, game definition and authoritative state stay in the interpreter.
Private handles own a dispatcher closure; no state or host functions are placed
on the game's globals. The local 503,134-byte WASM asset is loaded lazily from the
pinned package. No debug/async variants or web WASM are installed.

The Node alternative uses one dedicated child process per match, a `vm` context
without Node objects or callbacks, disabled string/WASM code generation and a
64 MiB V8 old-space limit. The child starts with `--permission`, read permission
only for its built worker/runtime directory and `--experimental-vm-modules`.
No write, child-process, worker or addon permission is granted. The parent kills
the process after a 1000 ms deadline. This is a disposable comparison adapter,
excluded from public package exports.

Both remove I/O, time and entropy globals before evaluating the game. Forbidden
property reads throw, including direct reads of `globalThis.constructor`. Module
imports cannot load host code. QuickJS rejects queued asynchronous jobs rather
than letting a rejected dynamic import masquerade as a successful synchronous move.

## Measurements

| Metric                              | D-008 criterion         | QuickJS fixture                  | Node VM process fixture          |
| ----------------------------------- | ----------------------- | -------------------------------- | -------------------------------- |
| Move p95, 500 samples               | Harbor Market <20 ms    | 1.69 ms                          | 0.71 ms, including IPC           |
| Warm load + setup p95, 20 samples   | New match <300 ms       | 71.42 ms                         | 89.48 ms                         |
| First cold load + setup             | New match <300 ms       | 148.25 ms                        | 88.18 ms                         |
| Idle QuickJS interpreter heap       | Idle match <16 MB       | 2,146,359 bytes (2.05 MiB)       | Not applicable                   |
| Parent RSS growth / 21 idle matches | Diagnostic only         | 4,001,792 bytes/match (3.82 MiB) | Not meaningful without child RSS |
| VM child heap / whole-process RSS   | Idle match <16 MB       | Not applicable                   | 13.03 MiB / 66.41 MiB            |
| Direct Node hashes reproduced       | Determinism             | 500/500 steps                    | 500/500 steps                    |
| Hostile cases contained             | All INT-ISOLATION cases | 9/9                              | 9/9                              |
| Infinite move return time           | Deadline +500 ms        | 1006.92 ms                       | 1003.31 ms                       |
| Allocation loop return time         | Deadline +500 ms        | 1344.27 ms                       | 125.96 ms                        |

RSS deltas are approximate, include allocator/module overhead and are not a
rigorous per-match attribution. The VM parent RSS delta can be negative because
earlier QuickJS objects are reclaimed; the separate child's RSS is the useful
whole-process number. The VM's V8 old-space cap is not a total-process memory cap.

Each isolation run attempts: an infinite move, allocation loop, `fetch`, `process`,
`require`, the global-constructor escape path, dynamic `import()`, `Date.now()` and
`Math.random()`. Every attempted call yields `GAME_ERROR`; a healthy match continues
after each failure. No arbitrary exception text or stack is returned. Additional
tests bound setup and player-view loops, reject static imports, verify snapshot
restoration and rejection rollback, and sanitize validation failures. A normal CI
test compares Node/QuickJS hashes at each step across four seeds, including rejected
moves. Production room/server containment is not covered by these prototypes.

## Recommendation and remaining gates

Keep QuickJS as D-008's default. On this fixture it meets the latency and heap
targets, provides a separate interpreter heap, and avoids one roughly 66 MiB Node
process per idle match. The VM prototype is faster per move but its isolation and
memory tradeoffs do not justify changing the default on the available evidence.

This recommendation is provisional until the required Harbor Market workload runs.
Do not change D-008 to Accepted or mark T08 complete from these fixture measurements.
Before finishing T08:

1. Run both implementations with Harbor Market and repeat the latency, load, memory
   and determinism measurements using real legal-move sequences.
2. Obtain human confirmation of the sandbox choice, as required by AGENTS.md and T08.
3. Implement permission-restricted QuickJS host processes, immutable build-hash
   loading, validated IPC and the crash/restart client. A separate outer watchdog
   is necessary: QuickJS's interrupt cannot preempt every allocator/GC operation;
   allocation already consumed roughly 344 ms of the 500 ms return-time allowance.
4. Verify crash/over-limit recovery and other-match isolation through the production
   host/client, including exported snapshots plus subsequent events. Keep snapshots
   privileged and send only `viewFor` results to room clients.
5. Merge the spike write-up and complete the full task's checks.

Reference: the installed upstream QuickJS
[API and minimal-distribution documentation](https://github.com/justjake/quickjs-emscripten)
and Node's versioned
[permission model documentation](https://github.com/nodejs/node/blob/v24.12.0/doc/api/permissions.md).
Passing this finite hostile corpus is evidence for this prototype, not a security audit.
