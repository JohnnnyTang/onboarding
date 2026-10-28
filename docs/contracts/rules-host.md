# Contract: privileged rules host

Server-only IPC version: **`HOST_PROTOCOL_VERSION: 1`**. This is separate from
`PROTOCOL_VERSION`, which versions the browser WebSocket protocol. These messages
must never be forwarded to browsers. Schemas live in `@bgp/schema`.

## Builds and matches

`BuildStore.load(buildHash)` returns `{ entry, files, source }` (`HostBuildSchema`):
`files` maps every version path to its SHA-256 digest, `entry` names the game bundle,
and `source` is its UTF-8 content. The host client verifies the manifest contract's
build hash over the sorted file index and the entry digest before caching the source.
T10 supplies the finalized immutable version store. The entry has a 2 MiB UTF-8 cap.
The child receives source through IPC and cannot read the version store.

The server client API is:

| Method                               | Meaning                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `load(buildHash)`                    | Verify and pin an immutable build; call before creating matches           |
| `create(matchId, init)`              | Create a match; `init` is `MatchInit` plus `buildHash`                    |
| `apply(matchId, seat, intent)`       | Return an accepted event or runtime rejection; never return full state    |
| `views(matchId)`                     | Return a record of seat IDs to `viewFor` results                          |
| `hash(matchId)`                      | SHA-256 of canonical authoritative state                                  |
| `exportState(matchId)`               | Export privileged authoritative state, including RNG                      |
| `restore(matchId, snapshot, events)` | Replace recovery checkpoint with snapshot and consecutive accepted events |
| `dispose(matchId)`                   | Forget the match and terminate its process                                |

One match pins one build for its lifetime. Duplicate creates fail. Calls for a
match are serialized; calls for different matches proceed independently.

## Child messages

Requests (`HostRequestSchema`) are `{ v: 1, id, command }`. `id` is a positive
integer increasing per process. Commands are strict objects:

- `{ op: "load", source, timeoutMs, memoryLimitBytes }`
- `{ op: "prepare" }` (load the trusted interpreter module in an unassigned spare)
- `{ op: "create", init }` (ordinary `MatchInit`, without build hash)
- `{ op: "apply", seat, intent }`
- `{ op: "views" }`, `{ op: "hash" }`, `{ op: "exportState" }`
- `{ op: "restore", snapshot, events }`
- `{ op: "dispose" }`

Successful replies (`HostResponseSchema`) are `{ v: 1, id, ok: true, value }`.
Prepare/create/load/restore/dispose return `null`; apply returns `HostMoveOutcomeSchema`;
views returns `HostViewsSchema`; hash returns a lowercase SHA-256 string; export
returns `MatchStateSchema`. Every call validates its operation-specific result.
Failures are exactly `{ v: 1, id, ok: false, code: "GAME_ERROR", message:
"Game execution failed" }`. Malformed envelopes disconnect the child. Neither
exceptions nor stdout/stderr cross into the server or browser response.

IPC envelopes have an 8 MiB serialized UTF-8 cap in both directions. A parent
watchdog kills the child at `timeoutMs` (default/maximum 1000 ms). The QuickJS
interrupt uses the same limit. Default/maximum interpreter heap: 64 MiB; stack:
512 KiB. Node old space is separately limited to 128 MiB. These are heap limits,
not an OS limit on whole-process RSS. Each process gets Node permission flags
allowing reads only in the built host directory, with no writes, subprocesses,
workers or addons. No Node objects or callbacks are exposed to game code.

The child also uses `--max-semi-space-size=1 --optimize-for-size`. The 128 MiB
old-space cap and full 64 MiB interpreter limit remain available. This tunes
collection without shrinking the permitted game heap or IPC/source size limits.

## Idle lifecycle

`RulesHostClientOptions` adds `idleTimeoutMs` (default 10000; integer 0..3600000,
with 0 disabling retirement) and `warmSpareCount` (default 1; integer 0..2).
After inactivity the client queues a checkpoint, compacts acknowledged events
and destroys that match's process. A subsequent operation reloads the pinned
source and restores the checkpoint before executing; all API methods remain
available. Idle cleanup shares the match's serial queue and operation deadline.
Failures retain the previous checkpoint and acknowledged journal for recovery.

The small reserve contains only unassigned processes. `prepare` loads trusted
interpreter code, with no game definition, context, state or RNG. Once assigned,
a process belongs to that one match until destroyed. It is never returned to
the reserve, so native crashes and retained game data cannot cross assignments.
Unused crashed reserves are replaced on acquisition; `close` and `dispose` cancel
idle timers and release their processes. Supervision may inspect assigned PIDs
through `processId` and reserve PIDs through `spareProcessIds`; neither is player
data. A retired match has no assigned PID until an operation resumes it.

Report active per-process RSS, the fixed shared reserve, suspended-match data in
the parent and cold/resume latency separately. Amortizing a reserve over many idle
matches must state the sample count; it is not a per-process memory reduction.

## Recovery and delivery

The client retains a validated checkpoint and the accepted events it has
acknowledged. After a process dies, the next call spawns a new restricted process,
reloads the pinned source, and restores that checkpoint plus events. A failed call
returns fixed `GAME_ERROR` immediately; an uncertain move is never retried. If a
child applied a move but died before acknowledging it, recovery discards that move.
The server can then explicitly submit it again. Successful restoration must
reproduce every accepted event exactly, including its original validated intent.
Successful `exportState` calls advance the in-memory checkpoint and compact its
journal. The returned snapshot is detached from that checkpoint. T11 should export
at its required snapshot cadence, keeping recovery bounded as matches grow.
Explicit restore can replace a dead host directly without replaying an older
journal first; restored seats must match the match's original seats.

This in-memory journal survives child crashes, not server restarts. T11 owns
durable snapshots/logs, persistence before broadcast, and browser resync. After
a server restart, create the match with its pinned build, then restore the stored
snapshot and subsequent events. `exportState` is server data; `views` is the only
game payload suitable for forwarding to players, one seat at a time.
