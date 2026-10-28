# Rules sandbox spike

This package currently contains T08's sandbox prototypes. It is not yet the
production process host: permission-restricted QuickJS hosting, the build-cache
loader, validated IPC, restart/recovery client and Harbor Market measurements
remain to be implemented after the sandbox choice is confirmed.

`QuickJsSandbox.load(source)` lazily loads the self-hosted synchronous release
QuickJS WASM. Each instance owns one interpreter runtime with a 64 MiB heap cap,
a 512 KiB stack cap and a 1000 ms interrupt deadline. The trusted `@bgp/rules`
bundle and import-free game module execute together inside that interpreter.
No host callbacks or Node objects are injected into the game.

The `RulesSandbox` interface provides create, apply, per-seat views, hash, privileged
snapshot export/restore and disposal. Inputs and returned state/events/views use
the existing `@bgp/schema` validators. Successful moves return only the accepted
event; views contain only `viewFor` output. Snapshot exports contain hidden state
and RNG data and must stay on the server. Hashing uses Node SHA-256 over canonical
JSON produced by the runtime without exposing a host crypto function to games.

Runtime errors are fixed `GAME_ERROR` messages; interpreter exceptions are never
dumped. A failed or interrupted interpreter is discarded. Dynamic imports and
queued asynchronous jobs are rejected. `Date`, random entropy, I/O globals and
the global constructor escape path are removed before loading game code.

The `spike/` VM comparison uses a separate Node process per match, `--permission`
with read access only to the built worker/runtime directory, no writes/children/
workers/addons, a 64 MiB V8 old-space cap and a parent-enforced deadline. It is
excluded from the public exports and must not be used for published games.

Run from the repository root:

```sh
pnpm --filter @bgp/rules-host... build
pnpm --filter @bgp/rules-host test
pnpm exec tsx scripts/t08-sandbox.ts
```

The last command records the comparison in `docs/spikes/t08-sandbox-results.json`.
Harbor Market is still a scaffold at the starting revision; the fixture results
must not be treated as the D-008 Harbor Market acceptance benchmark.
