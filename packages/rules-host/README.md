# Rules host

`RulesHostClient` is the server-only production entry point for untrusted games.
It verifies immutable build indexes and entry digests through `BuildStore`, pins
source and starts one restricted Node process per match. Each child owns one
QuickJS runtime, the trusted rules bundle, game code and authoritative state.
The public package exports the supervised client, not an in-process evaluator.

The [privileged IPC contract](../../docs/contracts/rules-host.md) documents every
method, validation boundary, size limit and recovery rule. Call `load(buildHash)`
before `create(matchId, { buildHash, seats, seed, options })`; then use `apply`,
`views`, `hash`, `exportState`, `restore` and `dispose`. `close()` releases every
match. T10 supplies the finalized immutable version store.

Successful moves return accepted events without authoritative state. Views come
only from `viewFor`; forward only the authenticated seat's view to that player.
Errors use fixed `GAME_ERROR` messages. Child output and interpreter exception
text are discarded. Snapshots include hidden information and RNG: keep them on
the server. `processId` is privileged supervision diagnostics for crash tests.

Failed calls discard the host and return without retrying uncertain moves. The
next call reloads the pinned build and restores the checkpoint plus acknowledged
events. `exportState` advances the detached in-memory checkpoint and compacts its
journal. T11 owns durable snapshots/logs, persistence before broadcast and browser
resync. In-memory recovery survives child crashes, not a server restart.

Defaults: a 1000 ms complete-operation watchdog, 64 MiB interpreter heap, 512 KiB
interpreter stack, 128 MiB Node old space and 8 MiB IPC envelopes. Limits may be
lowered. Parent watchdogs contain allocator stalls and native crashes. Child
permissions allow reads only in `dist/`, with no writes, child processes, workers
or addons. No Node objects or host callbacks are exposed to game code. Time,
entropy and I/O globals are removed before evaluating the game.

The build bundles dependencies into `host-entry.js` and lazily loads the local
pinned release WASM at `dist/quickjs.wasm`. Both installed and copied WASM paths
are inventoried. Keep the built host directory read-only in deployment.

```sh
pnpm --filter @bgp/rules-host... build
pnpm --filter @bgp/rules-host test
pnpm exec tsx scripts/t08-sandbox.ts # initial QuickJS vs VM fixture comparison
pnpm exec tsx scripts/t08-host.ts    # production IPC, memory, isolation and recovery
```

The VM adapter in `spike/` is comparison-only and excluded from public exports.
Current results use a hidden-counter fixture. Harbor Market is still a scaffold;
its required benchmark, the production idle-memory budget and human confirmation
remain T08 closure gates. See [validation](../../docs/t08-validation.md) and the
[spike report](../../docs/spikes/t08-sandbox.md).
