# T08 server sandbox comparison

Status: fixture comparison and production host/IPC/recovery validation complete;
Harbor Market benchmark, resource-accounting confirmation and human confirmation
pending. D-008 remains **Default**. This is an intermediate spike report, not a
claim that T08 or AC-09 is complete. The original prototype measurements below
are retained; the production section records the implemented host separately.

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

## Initial production host and recovery

`RulesHostClient` now implements the full server-facing API over validated,
versioned JSON IPC. It verifies version build hashes and entry digests, pins
source, serializes each match, and restarts crashed children from detached
checkpoints plus acknowledged events. Explicit snapshot export compacts the
recovery journal; T11 supplies durable storage and browser resync. Uncertain moves
are never retried. Only per-seat `viewFor` results may be forwarded to players.

Each match owns a Node process and a QuickJS runtime. Processes start with
`--permission --allow-fs-read=<host dist> --max-old-space-size=128`, an empty
environment, ignored output and no write/child/worker/addon permissions. The
distribution bundles the worker dependencies and self-hosts the single pinned
WASM asset. Its bundled `host-entry.js` is separate from TypeScript's intermediate
worker output so concurrent Turbo build/test tasks cannot overwrite it.

The parent enforces one 1000 ms budget across a complete operation, including
multi-step load/setup or restart/restore work. Its watchdog remains responsive
when the child is stuck in QuickJS allocation or GC. The production suite covers
all nine hostile cases, module/setup/view loops, malformed definitions, fixed
errors, parallel healthy-match progress, disposal, invalid restoration, idle
crashes and termination during a busy move. Busy-host recovery checks snapshot
plus subsequent events and verifies identical hashes, views and next moves.

Reproduce production measurements after building:

```sh
pnpm exec tsx scripts/t08-host.ts
```

Initial results: [t08-host-original-results.json](t08-host-original-results.json), measured on the same
Windows/CPU/Node configuration as above, using the hidden-counter fixture.
Create includes child startup, lazy interpreter load, setup and initial snapshot
export. Move latency includes IPC and boundary validation. There are 21 idle
processes, 20 warm-create samples and 500 moves, with every hash compared to Node.
The report also records whole-child working sets through the OS and a separate
direct interpreter's heap. Matches are created and moves measured sequentially;
the hostile tests exercise parallel healthy-match progress. This is not PERF-01.

| Metric                           | Production fixture result                  |
| -------------------------------- | ------------------------------------------ |
| Move p95, including IPC          | 2.65 ms                                    |
| Warm create p95                  | 274.60 ms                                  |
| Cold create                      | 254.26 ms                                  |
| Interpreter idle heap            | 2,298,414 bytes (2.19 MiB)                 |
| Whole idle child RSS, mean of 21 | 73,869,800 bytes (70.45 MiB)               |
| Reproduced direct Node hashes    | 500/500                                    |
| Idle crash restore + hash        | 234.52 ms, identical hash                  |
| Infinite move return             | 1006.84 ms; healthy match moved in 5.49 ms |
| Allocation loop return           | 1006.49 ms; healthy match moved in 2.86 ms |
| Hostile cases contained          | 9/9                                        |

Minifying the bundled host reduced warm-create p95 from an initial 323.27 ms to
274.60 ms on this fixture. Host startup and memory remain workload/platform
measurements, not guarantees. The interpreter heap is small, but whole-process
RSS exceeds the D-008 idle-match budget. One process per match currently earns
its overhead by containing native crashes and non-interruptible allocation.
This initial implementation did not meet the idle budget. The lifecycle rework
below addresses that cost while preserving the one-match process boundary.

## Idle lifecycle rework

After 10 seconds idle, a validated checkpoint retires the match's process. A
bounded reserve contains only unused processes prewarmed with trusted interpreter
code. A process that has run a game is never reused by another match. Every API
resumes from the pinned game and checkpoint with unchanged game and payload limits.

The [updated production run](t08-host-results.json) reproduces 500 Node hashes and
all 21 idle-resume hashes. Move p95 is 2.72 ms, create p95 is 151.55 ms and resume
p95 is 139.66 ms. All nine hostile cases remain contained by the public watchdog.

Active RSS averages 63.01 MiB. After all 21 matches retire, the shared reserve
uses 52.95 MiB total: 2.52 MiB per idle match. Including the entire measurement
parent gives 6.66 MiB per match at that sample count. This meets the idle fixture
target without claiming a single-match service or active process fits in 16 MB.
See [t08-memory.md](t08-memory.md) for profiles, fixed overhead and full API tests.

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
3. Confirm Harbor Market memory using the active/reserve/parent accounting in Q-011.
   Keep the 16 MB idle target; do not substitute interpreter heap alone.
4. The production implementation and fixture verification described above are now
   complete. T11 still owns real room-server persistence/resync integration; this
   report claims host/client recovery, not end-to-end AC-10 completion.
5. Merge the updated spike write-up after the remaining decisions and complete the
   full task's checks. The original prototype write-up is already on main.

Reference: the installed upstream QuickJS
[API and minimal-distribution documentation](https://github.com/justjake/quickjs-emscripten)
and Node's versioned
[permission model documentation](https://github.com/nodejs/node/blob/v24.12.0/doc/api/permissions.md).
Passing this finite hostile corpus is evidence for this prototype, not a security audit.
