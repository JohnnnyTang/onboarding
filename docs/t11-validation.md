# T11 validation: room server

Completed on 2026-11-03 on the `claude/t11-room-server` branch, based on `1c9e726`
(T10 complete).

## Delivered

- `GET /ws` in `apps/server` through `@fastify/websocket` 11.3.4 on `ws` (D-004), in the
  API process. `ClientConnection` runs the `hello` handshake (10-second deadline, the
  check order in [protocol.md](contracts/protocol.md#server-behavior-t11)), validates
  every client frame with `ClientMessageSchema`, applies the per-connection rate limits
  and parses every outgoing frame with `ServerMessageSchema` before sending it.
- `Room`: one serial queue per match. A move goes to the rules host. If it is accepted,
  one transaction stores the event, bumps `last_seq` and, when needed, writes a snapshot
  and the result. Only after that commit does any connection receive a patch. Snapshots
  are written at seq 0 (first activation), every 50 events and at the end.
- Each connection keeps the last view it was sent. Patches are RFC 6902 operations from
  fast-json-patch 3.1.1 (the tech-stack default, behind `diffViews`). A change whose patch
  is over 8 KiB and longer than the view is sent as a `snapshot` instead. `resync` returns
  a snapshot.
- Recovery: a room rebuilds from the latest stored snapshot plus later events, and checks
  the stored hash where one exists for the current seq. This happens on first load (which
  covers server restarts), after a failed persistence and when the rules host reports a
  dead process through the new `RulesHostClientOptions.onProcessExit`. After a rebuild
  every connection gets a fresh `snapshot`.
- Presence (in the `welcome`, in `presence` messages and in HTTP match summaries), chat,
  ephemeral relay, ping/pong, seat takeover, and abandon closing live connections with
  `MATCH_NOT_ACTIVE`. A dragged item ID is relayed only to seats whose current view already
  contains it; other seats get a plain pointer.

## Checks

| Command                          | Evidence                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                     | 10 build tasks pass                                                                                           |
| `pnpm typecheck`                 | 17 tasks plus root tooling pass                                                                               |
| `pnpm lint`                      | Biome and package-boundary checks pass                                                                        |
| `pnpm test`                      | 17 tasks and 48 root tooling tests pass                                                                       |
| `pnpm --filter @bgp/server test` | 126 tests in 14 files (23 room tests), against `bgp_t11_test`                                                 |
| `@bgp/rules-host` tests          | 66 tests, including the new process-exit notification test                                                    |
| Built server smoke run           | `node dist/main.js` on port 3100: `/api/healthz` ok; a bad-token `hello` gets `UNAUTHORIZED`, then close 1008 |

The room integration tests run in `apps/server/test/room-harbor.test.ts` and
`room-protocol.test.ts`, against a real listening server (port 0), real PostgreSQL and
real rules host processes. The clients are spy clients on Node's built-in WebSocket. Every
received frame must parse as a protocol server message.

- **INT-LEAK.** A 3-seat Harbor Market match plays to the end, driven by a bot that
  decides from its own seat's view. A second, independent rules host replays the same seed
  and moves as the oracle. After every move, each seat's view (rebuilt from `welcome`,
  patches and snapshots) must equal that seat's `playerView`. No frame sent to a seat may
  contain an ID from the deck, the box or another seat's hand, nor `"rng"` or `"seed"`.
  The test also checks that the event row exists by the time the first patch arrives.
- **INT-REPLAY.** The same finished match is fetched from the replay endpoint and replayed
  in a fresh rules host. Its final hash equals the stored final snapshot's hash, and the
  stored result equals the replayed one.
- **INT-RECOVERY.** The match's rules host process is killed with SIGKILL. Every client
  receives a `snapshot` at the unchanged seq, the server's hash equals the oracle's, and
  play continues. The server is then shut down (clients see close 1001) and a new server
  with a new rules host is started. Clients reconnect with `lastSeq`, the hashes still
  match, and the match plays to the end and passes INT-REPLAY.
- **Resync.** A client that drops a patch sends `resync`, gets a snapshot equal to its
  `playerView`, and applies later patches on top of it.
- **Error codes.** `room-protocol.test.ts` produces every code in protocol.md and asserts
  that the set matches `ErrorCodeSchema`. The room produces the room codes, including
  `GAME_ERROR` (an infinite loop, stopped within 1.5 s with the match still running),
  `RATE_LIMITED`, `SEAT_TAKEN_OVER` and `INTERNAL` (a corrupted stored snapshot hash). The
  HTTP API produces `NOT_FOUND`, `CONFLICT` and `VALIDATION_FAILED`.
- **Snapshot cadence.** The bot finishes Harbor Market in about 21 moves. A small fixture
  game therefore plays 120 moves (snapshots at 0, 50 and 100) and then ends at 121 (a
  snapshot at 121). A fresh server rebuilds that match from the seq 100 snapshot plus
  events 101–120.

Room tests need concurrent connections, so they commit real rows instead of rolling back.
Every fixture uses fresh users and slugs, and `match_events` is append-only, so those rows
stay in the test database. Two T10 schema tests that read whole tables now filter by their
own fixture IDs.

## Not covered here

- Sandbox matches cannot be hosted yet (Q-017): the rules host serves enforced builds only,
  and `hello` on an active sandbox match fails with `INTERNAL`. E2E-03 (T17) needs this.
- Owners without a seat, and spectators, are refused with `FORBIDDEN` (Q-016).
- The kill in INT-RECOVERY happens between moves. A crash during a move is handled by the
  same code path (`GAME_ERROR` for that move, then a rebuild and snapshots); the T08
  rules-host tests cover the busy-host kill itself.
- PERF-01 (20 concurrent matches, p95 < 200 ms) remains a T20 gate.
- Tokens are verified at `hello` only; an open connection outlives its token's expiry.
