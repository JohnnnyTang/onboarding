# Phase 1 spec: Designer sandbox

**Goal:** a designer can put a board game on a virtual table, playtest it remotely with invited guests in the browser, and, for games written with the SDK, have the rules enforced. Nothing to install for anyone; designers' unpublished work stays on their machine.

**Gate to Phase 2:** designers keep coming back to playtest their own games with remote guests, without being asked.

## Users and their flows

**Designer, sandbox game (no code)**

1. Opens the web app, creates a project (no sign-in needed), works offline if they like.
2. Adds component art, or generates card faces from a template plus a CSV file.
3. Declares zones (deck, market, one hand per seat…) and the starting setup.
4. Tries it in hot-seat mode, viewing any seat.
5. Signs in, publishes the project as a private or unlisted game version.
6. Creates a match, copies an invite link per seat, sends them out.
7. Plays with guests using manual operations; watches the replay afterwards.

**Developer, enforced game (code)**

1. `bgp init` scaffolds a game package; `bgp dev` opens a hot-seat table with hot reload.
2. Writes rules against the SDK; runs `bgp validate` (schema, determinism and hidden-information checks with the random bot).
3. `bgp publish` uploads a version; from there the flow matches the designer's steps 6–7.

**Guest playtester**

1. Opens an invite link, enters a display name, lands in the lobby, then the table.
2. Plays on desktop or phone; refreshes or loses connection without losing the seat.

## In scope

| Area            | Included                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules runtime   | Everything in [contracts/rules-api.md](contracts/rules-api.md); sandbox definition and manual operations                                                                   |
| Reference game  | Harbor Market, fully enforced ([reference-game.md](reference-game.md))                                                                                                     |
| Table           | 2D renderer (PixiJS) with stacks, rows, fans, grids, free zones; drag and drop; selection; action bar; HUD; per-seat view rotation; responsive down to a 360 px wide phone |
| Projects        | Local-first projects in IndexedDB; component and zone editor; setup editor; image import                                                                                   |
| Card generator  | Layout template (text and image fields in mm) + CSV rows → PNG card faces                                                                                                  |
| Hot-seat        | Full runtime in the game worker; seat switcher; "all seats" debug view for the designer                                                                                    |
| Publishing      | Project or package → game version via the upload flow ([contracts/manifest.md](contracts/manifest.md))                                                                     |
| Matches         | Create, invite links, lobby, start, play, finish, abandon; reconnect; presence; simple chat                                                                                |
| Replays         | Step through a finished match from its log                                                                                                                                 |
| Accounts        | Designer sign-in with OIDC; guests by invite                                                                                                                               |
| CLI             | `bgp init`, `bgp dev`, `bgp validate`, `bgp build`, `bgp publish`                                                                                                          |
| Isolation       | Game worker (D-007) and rules host with the sandbox chosen in the T08 spike (D-008)                                                                                        |
| Decision spikes | T08 server sandbox, T13 2D renderer, with write-ups in `docs/spikes/`                                                                                                      |

## Out of scope for Phase 1

3D rendering, physics, materials; the shared asset library and asset pipeline; partial rule enforcement and AI rule drafting; bots beyond the random test bot; simulation and balance reports; public listing, discovery and matchmaking; async play notifications; spectator mode beyond the owner; voice or video; print-and-play PDF export; live multi-device sync of projects; payments; localization (English UI only, but keep strings in one place).

Stretch, only if everything else is done: per-moment playtest feedback comments (`match_feedback`).

## Acceptance criteria

Each criterion is checked by the test named in brackets ([testing.md](testing.md)).

| ID    | Criterion                                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | A designer creates a sandbox project offline (network disabled), adds images, generates at least 10 cards from a template and CSV, declares zones and setup, and plays it in hot-seat mode. [E2E-01]                                           |
| AC-02 | A signed-in designer publishes that project; the version becomes ready with a build hash; re-publishing identical files yields the same hash. [E2E-02, INT-UPLOAD]                                                                             |
| AC-03 | The designer creates a 3-seat match; two guests in separate browser contexts join by invite link; all three play with manual operations; every change appears for the others. [E2E-03]                                                         |
| AC-04 | In sandbox and in Harbor Market, no seat's messages ever contain the identity of a card it may not know. [UNIT-LEAK, INT-LEAK]                                                                                                                 |
| AC-05 | Harbor Market plays to completion in a 4-seat remote match; illegal moves show the game's message; the result screen shows winners and scores. [E2E-04]                                                                                        |
| AC-06 | Refreshing the page mid-match returns the player to the same seat with the current view within 3 seconds on a local network. [E2E-05]                                                                                                          |
| AC-07 | A finished match replays step by step; the replayed final state hash equals the stored one. [INT-REPLAY]                                                                                                                                       |
| AC-08 | 1,000 random Harbor Market games are deterministic: replay from seed and events reproduces every state hash, in Node and in a browser. [PROP-DET, E2E-06]                                                                                      |
| AC-09 | A game whose move loops forever is stopped within 1.5 seconds with `GAME_ERROR`; the room server and other matches keep working. A game that touches `fetch`, `process` or `require` fails without effect. [INT-ISOLATION]                     |
| AC-10 | Killing the rules host process during an active match recovers the match automatically with the same state hash. [INT-RECOVERY]                                                                                                                |
| AC-11 | p95 move round trip (send `move` → receive `patch`) is under 200 ms with 20 concurrent matches on one server on a local network. [PERF-01]                                                                                                     |
| AC-12 | The 2D table works in current Chrome, Firefox and Safari on desktop, and Safari on iOS and Chrome on Android, at 360 px width and up. [E2E matrix]                                                                                             |
| AC-13 | `bgp init` → `bgp dev` → `bgp validate` → `bgp publish` works for a new game package following the docs alone. [E2E-07]                                                                                                                        |
| AC-14 | Every `.wasm` file in build outputs and in the production dependency tree is listed in `wasm-inventory.json` with a D-002 entry; in Phase 1 that is only the QuickJS module in the rules host, and the web app ships none. [CI-WASM-INVENTORY] |
| AC-15 | `pnpm dev`, `pnpm test`, `pnpm test:e2e` work on a clean machine following [dev-environment.md](dev-environment.md). [manual check at handoff]                                                                                                 |
