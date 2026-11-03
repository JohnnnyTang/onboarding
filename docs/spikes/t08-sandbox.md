# T08 server sandbox comparison

Status: complete. Fixture comparison, production host/IPC/recovery validation and
the Harbor Market benchmark with D-008 memory accounting are done; QuickJS meets
every D-008 criterion on Harbor Market. The project owner confirmed QuickJS on
2026-11-03, so D-008 is **Accepted** and T08 is complete. The original prototype
measurements below are retained; the production and Harbor Market sections record
the implemented host separately.

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

## Harbor Market workload

`pnpm exec tsx scripts/t08-harbor-market.ts` (after `pnpm build`, with no other
tests running) records results in
[t08-harbor-market-results.json](t08-harbor-market-results.json). It bundles the
game exactly as the package build does (790,792 bytes, import-free) and records 21
complete legal games with the seeded `runMatch` bot: 2, 3 and 4 seats, short and
full length, 2,436 accepted moves (20 to 215 per game). Each game is replayed move
by move through the production `RulesHostClient`, the QuickJS sandbox and the VM
process prototype. Every state hash (2,457 per path) matches direct Node
execution, and seat views match at setup and at the end of every game.

Two runs on 2026-11-03 (Windows x64, Node v24.12.0, ranges across both runs):

| Measurement                      | Criterion | Production (QuickJS + IPC)        | QuickJS sandbox           | VM process prototype      |
| -------------------------------- | --------- | --------------------------------- | ------------------------- | ------------------------- |
| Move p95                         | < 20 ms   | 12.8–14.2 ms (max 19.7–24.1)      | 11.5–11.6 ms              | 6.2–6.7 ms                |
| New match load (create) p95      | < 300 ms  | 220–255 ms; first 190–202 ms      | warm 113 ms; cold 206–218 | warm 123–125 ms; cold 119 |
| Cold client start to first match | —         | 296–354 ms (waits for reserve)    | —                         | —                         |
| Active memory per match          | —         | RSS 66.6–68.6 MiB (max 71.8)      | heap 4.58 MiB (max 5.15)  | child RSS 70.5–72.2 MiB   |
| Idle memory per match (21)       | < 16 MB   | 2.46–2.52 MiB children only       | —                         | —                         |
| Idle incl. whole parent          | —         | 6.52–7.35 MiB (parent 84–103 MiB) | —                         | —                         |
| Resume p95 (idle → hash)         | —         | 213–215 ms, 21/21 hashes restored | —                         | —                         |

Production creates are measured 2 s after the client starts, as on a running
server whose reserve process has booted. The cold row is measured separately with
a fresh client: its first create waits for Node and QuickJS start-up and lands
around the 300 ms line. That is a server-start cost, paid once, not per-match
load. Create and resume times are dominated by evaluating the 790 KB bundle in the
interpreter; a smaller game bundle is the main lever if this margin shrinks.

Idle accounting follows D-008's memory measurement rules: all 21 matches retired to checkpoints, leaving one
shared unused reserve process (51.6–53.0 MiB), amortized across 21 matches. The
parent includes the measurement runner and recorded games; it runs production
before the spike phases so their sandboxes do not inflate it. The 64 MiB
interpreter cap, 128 MiB Node old space and IPC limits are unchanged.

The INT-ISOLATION hostile corpus does not depend on the game; it passes in the
rules-host integration suite against the same production host.

## Recommendation and gates

Keep QuickJS as D-008's default and confirm it (confirmed 2026-11-03). On Harbor Market it meets every
spike criterion with margin on moves (p95 about 12–14 ms including IPC against
20 ms) and memory (about 2.5 MiB per idle match against 16 MB), and meets the
load criterion at p95 220–255 ms. The VM prototype is about twice as fast per move,
but each match costs a ~71 MiB Node process and `vm` is not a security boundary;
neither speed nor load justifies switching.

Gates:

1. Done: both implementations ran Harbor Market legal-move sequences with
   identical hashes, and the latency, load, memory and determinism measurements
   above replace the fixture-only evidence.
2. Done: Harbor Market idle memory measured with the active/reserve/parent
   accounting in D-008, against the retained 16 MB target.
3. Done: the project owner confirmed QuickJS on 2026-11-03; D-008 is Accepted
   and T08 is complete.
4. T11 still owns real room-server persistence/resync integration; this report
   claims host/client recovery, not end-to-end AC-10 completion.

Reference: the installed upstream QuickJS
[API and minimal-distribution documentation](https://github.com/justjake/quickjs-emscripten)
and Node's versioned
[permission model documentation](https://github.com/nodejs/node/blob/v24.12.0/doc/api/permissions.md).
Passing this finite hostile corpus is evidence for this prototype, not a security audit.
