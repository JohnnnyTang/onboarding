# T08 idle-host memory rework

After 10 seconds without a call, the serial match queue exports a validated
checkpoint, compacts acknowledged events and destroys its process. Every API
resumes from the pinned game and checkpoint. One shared unused process is
prewarmed to reduce resume latency. Once assigned, a process belongs to that one
match until destroyed. Native crashes and allocator stalls remain contained.

The measured 21-match fixture fits the original 16 MB idle goal. The 64 MiB game
heap, 128 MiB Node old space, 2 MiB source limit and 8 MiB IPC limit are unchanged.
D-008 stays Default until Harbor Market and human confirmation.

## Options tried

Raw exploratory profiles: [baseline](t08-memory-baseline.json) and
[optimized](t08-memory-optimized.json). Each profile uses five independent
processes, four warm creates and 100 moves, comparing every hash to direct Node.
These small profile runs guide implementation; the larger production run below
provides the final fixture evidence.

- Bare permission-restricted Node processes use about 49 MiB RSS on this machine,
  before loading game or interpreter code. A dedicated process cannot fit in 16 MB.
- Smaller 32/64 MiB old-space limits save little idle memory and reduce payload
  headroom. Keep 128 MiB old space and the full game/source/IPC limits.
- `--max-semi-space-size=1 --optimize-for-size` reduces young-generation retention.
  The selected 128 MiB exploratory profile averages 63.03 MiB RSS.
- Disabling JS optimization adds little saving. The WASM baseline-only testing
  flag saves little and slows moves. Neither option is shipped.
- The pure schema package declares `sideEffects: false` to omit unused modules.
  Minifying the trusted runtime reduces its source from 882,948 to 485,018 bytes
  and measured interpreter heap from 2.19 to 1.56 MiB.
- Splitting schema files did not materially improve memory and was discarded.
- Idle checkpointing provides the large reduction by retaining authoritative state
  in the existing supervisor while releasing inactive match processes. Only unused
  trusted processes are pooled; assigned hosts are never returned to the reserve.

No dependency or WASM module was added. Permissions, removed game capabilities,
fixed errors and the public 1000 ms watchdog remain unchanged.

## Measurement and accounting

```sh
pnpm --filter @bgp/rules-host... build
pnpm exec tsx scripts/t08-memory.ts optimized
pnpm exec tsx scripts/t08-host.ts
```

Run measurements separately from builds/tests and format changed JSON with Biome.
Machine: Windows x64, Intel Core Ultra 7 258V, Node v24.12.0, pnpm 11.9.0.
The [original production run](t08-host-original-results.json) and
[reworked run](t08-host-results.json) use the same hidden-counter fixture, 21
matches, 20 warm creates and 500 moves. These are not Harbor Market or PERF-01.
Move times include IPC and validation. Create times start at the API call;
reserve prewarming runs independently. `firstCreateMs` measures the first API
create, not cold service startup.

| Metric                                     | Original resident hosts | Reworked hosts               |
| ------------------------------------------ | ----------------------- | ---------------------------- |
| Assigned child RSS, mean                   | 70.45 MiB               | 63.01 MiB while active       |
| Child RSS per idle match, 21 matches       | 70.45 MiB               | 2.52 MiB including reserve   |
| Shared unused reserve after retirement     | none                    | 52.95 MiB total, one process |
| Parent RSS at idle measurement             | not recorded            | 86.98 MiB                    |
| Parent + all host children, divided by 21  | not recorded            | 6.66 MiB                     |
| Move p95                                   | 2.65 ms                 | 2.72 ms                      |
| Create p95                                 | 274.60 ms               | 151.55 ms                    |
| Idle resume p95                            | not applicable          | 139.66 ms                    |
| Crash checkpoint recovery, separate sample | 234.52 ms               | 121.58 ms                    |
| Direct Node hashes reproduced              | 500/500                 | 500/500                      |
| Idle resume hashes reproduced              | not applicable          | 21/21                        |
| Hostile cases contained                    | 9/9                     | 9/9                          |

After retirement there are zero assigned children. The reserve uses 55,525,376
RSS bytes; dividing by 21 gives 2.52 MiB per match. The parent uses 91,209,728
bytes; adding both gives 6.66 MiB per match. The parent includes the measurement
runner and a direct comparison interpreter, so this includes more than checkpoint
data. RSS counts shared pages in each process consistently across both runs.

This is an observed aggregate, not an OS cap or a per-process claim. At smaller
match counts the fixed reserve and service baseline cost proportionally more.
A single-match service does not fit under 16 MB total. `warmSpareCount: 0` removes
the reserve at the cost of cold startup on resumption. Report active RSS, reserve,
parent and sample count on Harbor Market before accepting D-008.

## Full functionality and containment

All 52 host tests pass, covering every API after retirement, identical resumed
hashes/views, checkpoint-plus-events crash recovery, moves queued around cleanup,
distinct process assignments, failed reserves and cancellation during preparation.
A 1.9 MiB source and 6 MiB snapshot retain support across retirement and resumption.
The full workspace suite passes 388 tests.

All nine hostile public calls retain the hard 1500 ms return assertion while
healthy matches progress. The measured allocation loop returns in 1005.20 ms.
An internal interpreter allocation test observed 1500.25 ms during rework: raw
QuickJS cannot preempt every allocator/GC operation. Internal tests verify
allocation rejection; the outer process enforces the production deadline.
No production deadline or containment test was relaxed.
