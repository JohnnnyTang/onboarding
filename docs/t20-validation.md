# T20 validation: hardening and handoff check

Work on the `claude/t20-hardening` branch, based on the T19 tip `8324d0d`.
Status: **open**. The project owner elected to keep physical-phone qualification
(AC-12) and the clean-machine run (AC-15) open. See
[Left for the project owner](#left-for-the-project-owner) for the remaining runs.

## Delivered

- **PERF-01** (`pnpm perf`, [scripts/perf/README.md](../scripts/perf/README.md)): starts the
  API and room server as its own process on loopback against a `bgp_perf` database, with a
  local RS256 issuer in place of Keycloak; publishes Harbor Market over the HTTP API; plays 20
  four-seat matches at once with scripted guests that apply patches with the web app's
  `applyViewPatch` and choose moves from their own views. A round trip is `move` sent to the
  mover's own `patch` received. It fails if p95 is not under 200 ms. The nightly CI job runs it
  and uploads the JSON result. Committed run: [docs/perf/perf-01-results.json](perf/perf-01-results.json).
- **Content security policy** (Q-031): built from the `VITE_*` settings; a meta tag in
  production builds, and from `vite preview` a header with `frame-ancestors 'none'` plus a
  stricter policy for the game worker's own script (`default-src 'none'; script-src 'self'
  blob:`). It allows the game bundle's blob module, the service worker (Q-020), the
  configured API, room and OIDC origins and the loopback `bgp dev` server (Q-030). No
  `'unsafe-inline'`, `'unsafe-eval'` or `'wasm-unsafe-eval'`: the table loads PixiJS's own
  `pixi.js/unsafe-eval` module, and browsers import the new `@bgp/schema/jitless` entry first
  so Zod 4 does not probe for `new Function`.
- **Designer reload against AC-06** (Q-018): a designer seated with their account reloads
  mid-match, clicks Sign in once (the Keycloak session signs them in without a form) and is
  back at the seat. Measured with three browsers in parallel: 0.8–1.5 s in Chromium and
  Firefox, about 2.5 s in WebKit, under the 3 s limit.
- **Keyboard operation**: M picks up the focused piece; the arrow keys walk drop targets
  (`keyboardDropTargets`: every other piece of a row, fan or grid zone, giving the gesture a
  pointer released on it would, and each droppable zone at its end or a free zone's centre);
  Enter or Space drops, Escape cancels. The canvas declares `aria-keyshortcuts`; the web app
  lists the keys under the table and links them with `aria-describedby`. The action bar was
  already plain buttons in tab order after the table. A Harbor Market match is now playable
  with the keyboard alone, including the swap that needed a drag.
- **Error and empty states** (reviewed below): a page error boundary; non-fatal room errors
  shown and no longer leaving a move pending forever; plain words for server failures; Try
  again on failed loads.
- **README and dev-environment.md** brought up to date (the README still called the API,
  room server, web flows and Harbor Market pending), with a troubleshooting section.
- **Device qualification aid**: `/dev/table/?fps=1` shows p50/p95 frame intervals, DPR and the
  WebGL renderer on screen, for phones without developer tools.
- **Test hardening**: E2E-01 and the publish test no longer fail on Windows when a closed
  browser still holds its temp profile; the designer reload test seats designer2 so the T12
  "designer1 has no matches" check holds on a reused e2e database.

## Error and empty states reviewed

| Where                                        | State                                    | Before                                 | Now                                    |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------- | -------------------------------------- |
| Every page                                   | Render error                             | Blank window                           | Message and Reload; header stays       |
| Match page                                   | Non-fatal room error (`RATE_LIMITED`, …) | Not shown; move stayed pending         | Dismissible notice; seat can act again |
| Match page                                   | Move rejected with `INTERNAL`            | "Internal server error"                | "the move was not made. Try it again." |
| Match page                                   | Fatal room errors                        | Plain messages and a way on (T14)      | Unchanged; `INTERNAL` reconnects       |
| Games, game, version, matches, lobby, replay | Failed load                              | Message only                           | Message and Try again                  |
| Games, versions, matches, projects           | Empty                                    | "No … yet" with the next step          | Unchanged                              |
| Match, lobby, replay                         | Not seated / signed out                  | Explains and offers Sign in            | Unchanged                              |
| Join                                         | Bad invite, seat taken, not in lobby     | Plain messages from the server         | Unchanged                              |
| Hot-seat, project                            | Project not on this device               | Explains                               | Unchanged                              |
| `/dev`                                       | No game, dev server down, broken build   | Explains; keeps the last working table | Unchanged                              |
| Any                                          | Unknown route                            | "Page not found"                       | Unchanged                              |

## Validation

Run on Windows 11 (Intel Core Ultra 7 258V, 8 cores, 31 GB) with Node 24.12.0, PostgreSQL 17 on
port 15432 (a native PostgreSQL holds 5432 on this machine; see dev-environment.md,
Troubleshooting) and Keycloak 26.8.0 from the Compose file.

| Check                                       | Result                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`, `pnpm lint`               | Pass                                                                                                                                                                                                                                                         |
| `pnpm build`, `pnpm check:wasm`             | Pass; the only WASM module is the rules host's QuickJS                                                                                                                                                                                                       |
| `pnpm test`                                 | Pass on the sequential rerun. 798 package tests and 75 tooling tests passed. |
| `pnpm test:e2e` (Chromium, Firefox, WebKit) | 94 passed, four expected skips, and one WebKit designer reload timing failure. The isolated WebKit rerun passed. |
| PERF-01 (`pnpm perf`)                       | 3,360 moves at 63/s: p50 56 ms, p95 71.7 ms, p99 84.1 ms, max 123 ms (limit: p95 < 200 ms)                                                                                                                                                                   |
| PROP-DET, 1,000 Harbor Market games         | Pass. Node replayed all 1,000 games in 27m 34s. Chromium replayed the same 1,000 games in 21.5 minutes and matched all 116,163 Node state hashes. |

In the November 6 matrix, E2E-01 and guest reloads passed in all three engines.
CLI publishing and the AC-08 property replay run only in Chromium. The WebKit
Q-018 designer reload measured 4,124 ms against the 3,000 ms limit while the
property runs were active. The isolated rerun passed after the property runs.
The workspace suite also passed after the property runs, including all 73
rules-host tests after the concurrent run hit watchdog failures.

### Reproduce AC-08

Run from the workspace root in PowerShell:

```powershell
pnpm --filter @bgp/testing... build
$env:BGP_PROPERTY_RUNS = '1000'
pnpm --filter harbor-market test -t PROP-DET
$env:BGP_E2E_APP = '0'
pnpm test:e2e e2e/harbor-determinism.spec.ts --project=chromium
Remove-Item Env:BGP_PROPERTY_RUNS, Env:BGP_E2E_APP
```

Both runs use fast-check seed `606`, 2–4 seats, and short and standard games.
The Node property verifies card conservation, integer-only state and replay hashes.
The Chromium test starts from the Node match seed and accepted events, then compares
every hash from setup to the result. It uses a test page with synthetic traces.
E2E-06 covers the production game worker against the rules host separately.

### Performance and replay timings

PERF-01 headroom: with no think time the same 20 matches ran 204 moves/s at p95 116 ms; 40
matches without think time saturated this machine at about 200 moves/s (p95 225 ms). Round
trips include the PostgreSQL commit of each event before its patch (protocol.md), which
dominates on this Docker-on-Windows setup.

E2E-06 replay stepping in the November 6 matrix (300 steps, p50 / p95 / max):
Chromium 50.8 / 97.2 / 340.9 ms, Firefox 20 / 40 / 73 ms, WebKit 66 / 119 / 233 ms.
The `INTERNAL` flake T19 saw in E2E-06 did not recur here or in PERF-01's 3,360 moves
at 20 concurrent matches.

## Acceptance criteria

| ID    | Status        | Evidence                                                                                                                                              |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | Pass          | E2E-01, `e2e/projects.spec.ts`, all three browsers, under the content security policy                                                                 |
| AC-02 | Pass          | E2E-02 `e2e/publish.spec.ts`; INT-UPLOAD `apps/server/test/int-upload.test.ts`                                                                        |
| AC-03 | Pass          | E2E-03 `e2e/publish.spec.ts`, all three browsers                                                                                                      |
| AC-04 | Pass          | UNIT-LEAK (`games/harbor-market/test/game.prop.test.ts`, `packages/testing/test/leaks.prop.test.ts`); INT-LEAK `apps/server/test/room-harbor.test.ts` |
| AC-05 | Pass          | E2E-04 `e2e/match.spec.ts`, all three browsers                                                                                                        |
| AC-06 | Pass          | E2E-05 (guest) and the Q-018 designer reload, `e2e/match.spec.ts`, all three browsers                                                                 |
| AC-07 | Pass          | INT-REPLAY `apps/server/test/room-harbor.test.ts`; the replay page in E2E-06                                                                          |
| AC-08 | Pass          | [Node PROP-DET](../games/harbor-market/test/game.prop.test.ts) and [Chromium property replay](../e2e/harbor-determinism.spec.ts) passed 1,000 games each. [E2E-06](../e2e/replay.spec.ts) passed in all three browsers. |
| AC-09 | Pass          | INT-ISOLATION `packages/rules-host/test/host-client.test.ts`; the endless move stopped under 1.5 s in `apps/server/test/room-protocol.test.ts`        |
| AC-10 | Pass          | INT-RECOVERY `apps/server/test/room-harbor.test.ts`, `packages/rules-host/test/host-client.test.ts`                                                   |
| AC-11 | Pass          | PERF-01, [docs/perf/perf-01-results.json](perf/perf-01-results.json)                                                                                  |
| AC-12 | **Open**      | Desktop Playwright Chromium, Firefox and WebKit pass at 360 px and 1440 px. Safari on iOS and Chrome on Android need the device run below.             |
| AC-13 | Pass          | E2E-07 `e2e/cli.spec.ts` (T19; `bgp dev` in all three browsers here)                                                                                  |
| AC-14 | Pass          | CI-WASM-INVENTORY, `pnpm check:wasm`                                                                                                                  |
| AC-15 | **Open**      | Needs a clean machine; the docs were brought up to date for it                                                                                        |

"All three browsers" means desktop Chromium, Firefox and WebKit through Playwright. Desktop
WebKit and synthetic touch do not stand in for iOS or Android (testing.md).

## Left for the project owner

Physical-device measurements and clean-machine smoke test results are pending.
T20 stays open until both are recorded here.

### Physical-device table qualification (AC-12, deferred from T13)

Run on one identified mid-range Android phone (Chrome) and one iPhone (Safari), both on the
same Wi-Fi network as the development machine.

1. Serve the renderer harness to the network: `pnpm dev:table --host 0.0.0.0`, then open
   `http://<machine-ip>:4313/dev/table/` on the phone.
2. Three-engine comparison: open `/dev/table/spike.html?engine=pixi&measure=1`, then
   `engine=three` and `engine=canvas`. Production renderer: `/dev/table/?stress=1&fps=1`
   (300 draggable cards; the overlay shows p50/p95 frame intervals, DPR and the WebGL
   renderer while you drag).
3. For each, record in the table below: device model, OS and browser version, DPR, the
   graphics backend where the page shows it, p50/p95 frame intervals against the 60 fps target
   (16.7 ms), and whether card text is readable after zooming in.
4. On `/dev/table/?stress=1` and the five-layout fixture, check by hand with real touch: drag
   and drop a card into each zone, pinch to zoom, pan, the seat rotation buttons, and the page
   from 360 px wide (portrait) to landscape.
5. Optional, the whole app: start the API with `PUBLIC_WEB_ORIGIN=http://<machine-ip>:5173`,
   build the web app with `VITE_API_URL=http://<machine-ip>:3000` and
   `VITE_WS_URL=ws://<machine-ip>:3000/ws`, serve it with `vite preview --host 0.0.0.0`, and join
   a match from an invite link as a guest (guests need no Keycloak sign-in, whose client only
   allows `localhost`). Plain-http LAN origins are not a secure context, so the replay page
   skips its hash check there.

| Device | OS / browser | DPR | Backend | Engine | p50 / p95 ms | Text | Touch checks |
| ------ | ------------ | --- | ------- | ------ | ------------ | ---- | ------------ |
|        |              |     |         | pixi   |              |      |              |
|        |              |     |         | three  |              |      |              |
|        |              |     |         | canvas |              |      |              |
|        |              |     |         | prod   |              |      |              |

### Clean-machine check (AC-15)

On a machine without this repository's tools beyond Node (`.nvmrc`), pnpm (`packageManager`)
and Docker, follow [dev-environment.md](dev-environment.md) from "Full development
environment" alone: `pnpm dev` opens the web app and sign-in works; `pnpm test` passes;
`pnpm build` then `pnpm test:e2e` passes. Note any step the docs did not cover.

## Decisions and open questions

- **Q-018** updated with the designer reload measurement.
- **Q-020** and **Q-030** done: the policy allows the service worker and the dev server.
- **Q-031** (new): how the content security policy is delivered, what it allows, and what a
  host must send once hosting is chosen (Q-002).

New dependencies: none (`pixi.js/unsafe-eval` ships with PixiJS). Contract changes: none;
`@bgp/schema` gains a `./jitless` entry point, not a schema change.
