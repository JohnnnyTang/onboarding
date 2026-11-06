# T18 validation: replay viewer

Completed on 2026-11-06 on the `claude/t18-replay-viewer` branch, based on `41a2199`
(T17 merged).

## Delivered

- **Final hash in the replay response.** `GET /api/matches/:matchId/replay` now returns
  `finalHash`, the `stateHash` of the snapshot the room stored with the last event, which
  the rules host computed. The contract doc, `ReplayResponseSchema`, the committed JSON
  Schema and the tests changed together. A finished match without its final snapshot is a
  server error (it cannot happen: the room writes one with the move that ends the match).
  Web and server ship together, so the stricter response needs no version bump; HTTP has no
  protocol version, and `PROTOCOL_VERSION` covers the WebSocket protocol only.
- **Replays in the game worker.** New requests `replayStart`, `replayAppend`, `replayView`
  and `replayHash`. The page sends events in chunks of 50, so each call keeps the 1 s game
  call deadline; a rejected or out-of-sequence event leaves the replay unchanged. The worker
  keeps the state after every event (each state is a full copy, so memory grows with match
  length; a few MB for 300 Harbor Market events). `replayHash` uses the Web Crypto digest
  that the worker captures before the lockdown removes `crypto`, so game code still cannot
  reach it; `hashWith` gives the same result as `hashState` (unit test). It is the only
  asynchronous request, and it never awaits anything game code returned. Without Web Crypto
  (a non-secure origin) the page says the final state could not be checked.
- **Replay page** (`/matches/:matchId/replay`, replacing the placeholder). For the match's
  host or a seat holder (designer token or the tab's guest seat, Q-018). It loads the match
  summary, the replay and the version, rebuilds the match with a progress line, then shows
  the hash check: "its hash matches the server's" with the first 12 hex digits, or an alert
  with both hashes. The table starts at the setup and steps with Setup, Back, Forward and
  End buttons or a slider (arrow keys, Home and End when focused). Each step names the seat
  and the move that led to it (the operation, for sandbox moves). Viewing: any seat, or all
  seats (Q-021's merge, moved to `apps/web/src/match/merge-snapshots.ts`). The last step
  shows the result, and the HUD shows scores throughout. Steps requested faster than they
  draw collapse into the latest, so holding a key or dragging the slider never queues work.
  Running and abandoned matches explain why there is no replay.
- **Sandbox end game** (Q-026, decided by the project owner). Sandbox matches could not
  finish, so they had no replay. The new manual operation `{ op: "endGame" }` lets any
  participating seat end the match with no winners and the reason "Ended by Seat N". It
  calls `ctx.events.endGame`, so the sandbox state does not change: existing sandbox hashes
  and golden replays are unaffected, and the match stores its final snapshot and replays
  like an enforced one. Browsers reach the hash QuickJS stored (E2E), and a fresh QuickJS
  sandbox repeats it exactly (rules-host test).
  The sandbox offers an "End game" button on every turn.
- **Confirm questions on action buttons.** `ActionButton` gains an optional `confirm`
  (1–200 characters). The action bar asks it in place of the buttons, with the action and
  Cancel, and drops the question if the button is no longer offered. The sandbox's End game
  asks "End the game for everyone? This cannot be undone." No browser dialogs.
- **Match page** links to the replay once the result arrives.
- **API client:** `getReplay`, scoped to the match so a guest token is used.

Contract changes, all additive and documented with their Zod schemas, JSON Schema export
and tests: `ReplayResponse.finalHash` (http-api.md), `ManualOp` `endGame` and the sandbox
details (components-and-table.md), `ActionButton.confirm` (rules-api.md). No new
dependencies. No WASM changes.

## Decisions and open questions

- **Q-021** updated: the replay viewer's all-seats view uses the same merge of seat
  snapshots, not the full state, although the seed and events of a finished match reveal
  every card anyway.
- **Q-026** (new, done): sandbox matches become replayable through the end-game operation
  (option A). Serving replays of abandoned matches was not chosen: abandon stores no final
  snapshot, so the hash check would be lost. It remains an option for enforced matches ended
  early.

## Checks

| Command                     | Evidence                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                | 10 build tasks pass                                                                                                                                                            |
| `pnpm typecheck`            | All tasks plus root tooling pass                                                                                                                                               |
| `pnpm lint`                 | Biome and package-boundary checks pass                                                                                                                                         |
| `pnpm test`                 | 17 tasks and 66 tooling tests pass: 175 schema, 93 rules, 73 rules-host, 170 web, 128 server (`bgp_test`), 28 Harbor Market, 21 table-2d, 21 card-generator, 19 testing, 1 cli |
| `pnpm check:wasm`           | Passes; only the rules host's QuickJS module, the web output has none                                                                                                          |
| `pnpm test:e2e --workers=1` | 71 of 72 pass in Chromium, Firefox and WebKit (9.3 min), before the end-game work; see below                                                                                   |

The full run's one failure was the Firefox screenshot in `table-2d.spec.ts` "seat rotation
and repeated authoritative snapshot animation" (18% of pixels differ). This branch does not
touch the renderer or that test; run on its own it passed 3 of 3 (`--repeat-each=3`), so
it is a timing flake under load. After the end-game commits, `e2e/replay.spec.ts` (6 tests)
and the specs that use the action bar or sandbox play (`projects`, `publish`, `match`,
`game-worker`: 21 tests) were run again in all three browsers and pass.

PostgreSQL ran on port 15432 because a native PostgreSQL holds 5432 on this machine.

**Done-when check.**

- **INT-REPLAY** (`apps/server/test/room-harbor.test.ts`): a 3-seat Harbor Market match
  played to the end through the room server is rebuilt from the replay endpoint's events in
  a fresh rules host; its hash equals both `finalHash` and the last stored snapshot's hash,
  and the result matches.
- **E2E-06** (`e2e/replay.spec.ts`) passes in Chromium, Firefox and WebKit. Three scripted
  guests play a 3-seat Harbor Market match to the end through the real room server, with 280
  swaps before playing normally (300 events in total), so the rules host (QuickJS) stores
  the final hash. Each browser opens the replay page as one of the guests, rebuilds the match
  in the game worker and shows "matches the server's" with the same hash.
- **300-event responsiveness.** The same test clicks Forward through all 300 steps and times
  each from the click until the step's snapshot is shown and the next frame has started
  (last run):

  | Browser  | p50   | p95   | Worst |
  | -------- | ----- | ----- | ----- |
  | Chromium | 46 ms | 55 ms | 78 ms |
  | Firefox  | 9 ms  | 14 ms | 26 ms |
  | WebKit   | 43 ms | 64 ms | 84 ms |

  The test fails at p95 150 ms or worst 500 ms, leaving room for a busy CI host. Jumping
  to the end, switching to all seats and back to a seat, and the slider's End key also keep
  up. No page errors.
- **Sandbox replay** (Q-026, same spec, all three browsers): a guest ends a 2-seat sandbox
  match with End game (Cancel first keeps playing), both seats get "Ended by Seat 1", and the
  replay link opens a replay with the rules host's hash and the result on the last step.

## Not covered here

- A seatless host can open the replay (the endpoint allows the owner) but cannot watch the
  live match (Q-016).
- Abandoned matches still have no replay (Q-026, by choice).
- The replay shows no chat and no per-moment feedback (`match_feedback` is a stretch goal).
