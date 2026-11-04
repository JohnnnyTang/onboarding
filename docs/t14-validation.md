# T14 validation: game worker and match page

Completed on 2026-11-03 on the `claude/t14-match-page` branch, based on `a533277` (T11, T12
and T13 merged).

## Delivered

- **Game worker** (`apps/web/src/workers/`). A dedicated module worker evaluates the version's
  bundle from a blob URL. Before that, `lockDownGlobals` makes the names the rules host locks
  throw when read (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Date`,
  `performance`, `crypto`, timers, `Worker`, `WebAssembly`, `Math.random`, ...). Browser-only
  capabilities that QuickJS lacks read as `undefined` (`indexedDB`, `caches`,
  `BroadcastChannel`, `importScripts`, `navigator`, the worker's own `postMessage` and
  listeners, and others). A game therefore behaves the same in both places. The worker
  refuses to load the game if any name could not be locked. It answers `present`,
  `interpret`, `actions` and a hot-seat runtime (`hotSeatCreate`, `hotSeatApply`,
  `hotSeatView`, for T15) over a private MessagePort. Replies carry no error details.
- **Worker client** (`src/match/game-worker-client.ts`). Startup has two phases: boot (the
  worker's own code, 30 s for slow networks) and load (the bundle, 5 s). Each call into game
  code has a 1000 ms deadline (D-008). A miss terminates the worker, and later calls fail.
  Every reply is validated with the `@bgp/schema` schemas.
- **Room client** (`src/match/room-client.ts`). It sends `hello` with the seat's credentials
  and rebuilds the seat's view from `welcome`, patches (fast-json-patch behind
  `applyViewPatch`) and snapshots. A seq gap or a patch that does not apply triggers a
  `resync`. It tracks presence, chat, rejections, the result and pending moves. It
  reconnects with jittered backoff and `lastSeq`, unless a fatal error means a new
  connection cannot succeed. Every frame is parsed with `ServerMessageSchema`.
- **Match page** (`/matches/:matchId`). It connects, loads the version named by `welcome`
  (manifest, components file, bundle, and images as object URLs because `<img>` cannot send
  a bearer token) and boots the worker in parallel. The view goes through `present` to the
  PixiJS table (loaded on demand). Renderer gestures go through `interpret`, and action
  buttons from `actions` (with the current selection) send their intents. The page shows
  the prompt, a HUD (names, scores, hand counts, the active seat, absent players), the
  game's message for a rejected move, chat, a connection banner, plain messages for fatal
  room errors and a result panel with winners and scores. Buttons are disabled while a move
  awaits acknowledgement. The lobby sends a seated player to the table when the host
  starts.

## Changes outside the web app

- **`GET /api/versions/:versionId`** (contract addition). Seat holders needed the manifest
  to find the bundle and the components file, but only owners could read versions. The new
  endpoint returns `VersionResponse` under the same rule as file downloads (owner or seat
  holder). It is documented in http-api.md and registered in `HTTP_CONTRACTS`, with tests.
- **Claimed seats in session storage** (Q-018). Guest seats, including the guest token, are
  kept in this tab's `sessionStorage`, so a reload returns to the seat (AC-06). The worker
  cannot read web storage, and designer tokens stay in memory. The project owner confirmed
  this on 2026-11-04 and D-007 was amended to allow it. The T12 test now checks that
  nothing token-like reaches local storage or cookies.
- **Rules host resume** (Q-019, approved by the owner on 2026-11-03). A move made after
  more than 10 s idle was lost with `GAME_ERROR` under CPU load. Two separate limits caused
  it: the parent gave the resume and the move one shared 1000 ms deadline, and inside
  QuickJS a single 1000 ms interrupt covered the trusted runtime bundle as well as the game
  module. Recovery (taking or starting a process, loading, restoring) now runs on
  `recoveryTimeoutMs` (default 5000). The trusted runtime is bounded by that watchdog, and
  the game's 1000 ms limit starts when its module is evaluated. The move then gets a full
  `timeoutMs`. Game code is limited exactly as before. The server's room tests disable idle
  retirement, which is why earlier tasks did not see this.
- **Idle tables stop drawing** (table-2d). The renderer redrew every frame even when
  nothing moved. Four headless tables (software WebGL) kept the machine busy enough to make
  E2E-04 fail intermittently. Pieces now snap into place when close to their target, the
  ticker stops after three frames without movement, and snapshots, selection, resizes,
  loaded textures and canvas input wake it. A new table-2d test counts WebGL draw calls: none
  while idle, some after a change. The existing screenshot baselines are unchanged.
- **Package boundaries.** `apps/web` may import `fast-json-patch`, and only
  `src/workers/game-module.ts` may import a computed URL (the bundle).
- **End-to-end server.** Playwright now serves a production build of the web app
  (`vite build` + `vite preview`). The unbundled dev server took 3.5–4.5 s to reload, which
  says nothing about AC-06.

## Checks

| Command                     | Evidence                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm build`                | 10 build tasks pass; the web build has separate worker and table chunks                    |
| `pnpm typecheck`            | 17 tasks plus root tooling pass                                                            |
| `pnpm lint`                 | Biome and package-boundary checks pass                                                     |
| `pnpm test`                 | 17 tasks pass: 93 web tests, 69 rules-host tests, 127 server tests (against `bgp_test`)    |
| `pnpm test:e2e --workers=1` | 60 of 60 pass in Chromium, Firefox and WebKit (5.1 min), against the shared local Keycloak |

The local PostgreSQL ran on port 15432, because a native PostgreSQL holds 5432 on this
machine. The shared Keycloak on port 8080 already includes the T12 realm fix.

The end-to-end tests that cover T14:

- **E2E-04** (`e2e/match.spec.ts`). A fixture publishes Harbor Market through the HTTP API
  (bundle built with esbuild as `bgp build` does, placeholder art). Four guests claim seats
  in separate browser contexts and play to the result screen through the page only: action
  buttons, and the table's keyboard focus and canvas label to select their own cards for
  discards and ships. Seat 1's first Restock is rewritten into Pass on the wire with
  `routeWebSocket`. The deck is not empty, so the game rejects it and the page shows
  "Another move is available." No test hook exists in the app. Every page then shows the
  result with winners and four score rows.
- **E2E-05** (`e2e/match.spec.ts`). In a 2-seat match, seat 2 reloads on its turn. The
  prompt, the HUD and the table are back within 3 s (about 2.2 s in Chromium), and the seat
  can still move.
- **Worker lockdown** (`e2e/game-worker.spec.ts`). Published probe games report, from inside
  the real worker in each browser, what they can reach at load and in `present`: `fetch`
  (also through `self` and the global's prototype), `indexedDB` and every other locked name
  are out of reach, and no request reaches the API. A game whose `present` never returns is
  stopped and reported as "The game stopped responding", and the page stays usable.

Unit tests cover the room client (handshake, patches, gaps, bad patches, invalid frames,
rejections, presence, chat, results, backoff, fatal errors), the worker entry over a
MessageChannel (presentation, deterministic hot-seat play, hidden game errors, invalid and
uncloneable output, deadlines, boot, refused lockdown), the lockdown on a fake global, the
table presenter, the game package loader, the API client additions, claimed seats and the
match page panels.

## Not covered here

- Each call into game code, in the browser and in the rules host, is still limited by wall
  time (D-008). A heavily overloaded machine can still turn a slow call into `GAME_ERROR`.
- Owners without a seat and spectators still cannot connect (Q-016). Sandbox matches are not
  hosted yet (Q-017), and the match page says so.
- A designer who reloads signs in again: OIDC tokens stay in memory (Q-018). That reload is
  not measured against AC-06's 3 s yet (T20).
- A guest who closes the tab loses the seat: each seat is claimed once, and a host cannot
  re-issue a seat's invite yet.
- Ephemeral drag and pointer relay is not shown on other seats' tables yet.
