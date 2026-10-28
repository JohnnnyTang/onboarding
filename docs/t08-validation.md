# T08 rules host validation

Production implementation branch: `codex/t08-host-completion`, based on `b40f329`.
The isolated worktree continues the prototypes already integrated into main.
T08 is **not complete**: the Harbor Market workload does not exist yet and the
production memory gate and human confirmation remain unresolved.

## Implemented and checked

- A public server-only `RulesHostClient`; `RulesSandbox` and its QuickJS
  implementation stay behind the restricted process boundary in production.
- One restricted Node process and one QuickJS interpreter per match; parent
  deadlines across full operations and interpreter time/memory/stack limits.
- Immutable source loading through `BuildStore`, with build-index and entry-digest
  verification. T10 supplies the version store and finalize lifecycle.
- Every required API operation, strict request/result schemas in `@bgp/schema`,
  JSON Schema exports and the [privileged IPC contract](contracts/rules-host.md).
- Per-match ordering, independent progress across matches, sanitized failures,
  cancellation/disposal, crash restart and detached checkpoint/event recovery.
- Exported snapshots compact the in-memory journal. Unknown move outcomes are
  discarded on recovery; mutating calls are never automatically retried.
- Local lazy WASM loading with installed and copied assets in the D-002 inventory.
  No new runtime dependencies.

The integration suite executes the real bundled worker under Node permission
flags. All nine INT-ISOLATION cases fail safely while healthy matches continue.
Loops in module evaluation, setup and views are also bounded. Killing a busy host
recovers the same acknowledged state hash and views from snapshot plus events;
the next accepted move matches an independent interpreter. This is host/client
INT-RECOVERY coverage. The room-server browser snapshot path belongs to T11.

The full workspace test run also exposed a TypeScript/bundler output collision
during concurrent Turbo build/test tasks. The production bundle now has its own
`host-entry.js` filename, and the full run passes with concurrent builds.
Host test files run sequentially so separate infinite-loop and allocation suites
do not compete for CPU while measuring fixed wall-clock deadlines. Run the full
test command separately from TypeScript builds or performance measurements.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:wasm
pnpm json-schema
pnpm exec tsx scripts/t08-host.ts
```

Local integration tests use the already healthy PostgreSQL/Keycloak services.
Final checks pass: workspace typecheck and lint, all 336 package/app tests plus
46 root tooling tests (382 total), all ten package/app builds, WASM inventory
(two copies of the same pinned binary, none in web output), and export of all 121
contract JSON Schemas. Of the package tests, 46 exercise the rules host.
Validation runs on Windows x64, Node v24.12.0 and pnpm 11.9.0. The benchmark
script records the CPU, timestamp, sample counts and measurements in
[t08-host-results.json](spikes/t08-host-results.json). Its 500 fixture moves
reproduce direct Node hashes. Measured production move p95 is 2.65 ms including
IPC, warm create p95 is 274.60 ms, and hostile loops return at roughly 1007 ms.
These measurements do not substitute for Harbor Market.

## Exact closure gates

1. T06 must provide Harbor Market. Run its legal move sequences through both
   spike implementations, compare every hash and measure D-008 latency/load/memory
   criteria. `games/harbor-market/src/index.ts` is still a scaffold at this base.
2. Resolve Q-011: per-match processes currently use about 70.45 MiB idle RSS,
   exceeding the <16 MB budget. Interpreter heap alone is 2.19 MiB. Meeting the
   production budget must preserve hostile-call and native-crash containment;
   any budget change requires explicit human agreement.
3. Obtain human confirmation of the measured sandbox choice, update D-008 and
   merge the updated spike report. AGENTS.md requires a human-agreed status change;
   a request to finish T08 is not recorded here as acceptance of unseen evidence.

Keep T08 open until these gates pass. Q-010 already explicitly forbids substituting
the small fixture for the required Harbor Market workload. No protocol/manifest
version changes are needed: the new server IPC has its own version 1.
