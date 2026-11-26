# T20 validation: hardening and handoff check

Work on the `claude/t20-hardening` branch, based on the T19 tip `8324d0d`.
Status: **complete**. The clean-machine run passed (AC-15). On 2026-11-26, the project owner permanently deferred Phase 1 physical-phone qualification. Desktop browser coverage for AC-12 passed.

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
- **Device qualification aid**: `/dev/table/?fps=1` measures intervals between frames submitted
  by the production renderer during a continuous card drag. It shows p50/p95, sample count,
  DPR and the table canvas's WebGL backend where exposed. The last reading stays visible
  after release.
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

| Check                                       | Result                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`               | Pass                                                                                                                                              |
| `pnpm build`, `pnpm check:wasm`             | Pass; the only WASM module is the rules host's QuickJS                                                                                            |
| `pnpm test`                                 | Pass on the sequential rerun. 798 package tests and 75 tooling tests passed.                                                                      |
| `pnpm test:e2e` (Chromium, Firefox, WebKit) | 94 passed, four expected skips, and one WebKit designer reload timing failure. The isolated WebKit rerun passed.                                  |
| PERF-01 (`pnpm perf`)                       | 3,360 moves at 63/s: p50 56 ms, p95 71.7 ms, p99 84.1 ms, max 123 ms (limit: p95 < 200 ms)                                                        |
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

| ID    | Status                                    | Evidence                                                                                                                                                                                                                |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | Pass                                      | E2E-01, `e2e/projects.spec.ts`, all three browsers, under the content security policy                                                                                                                                   |
| AC-02 | Pass                                      | E2E-02 `e2e/publish.spec.ts`; INT-UPLOAD `apps/server/test/int-upload.test.ts`                                                                                                                                          |
| AC-03 | Pass                                      | E2E-03 `e2e/publish.spec.ts`, all three browsers                                                                                                                                                                        |
| AC-04 | Pass                                      | UNIT-LEAK (`games/harbor-market/test/game.prop.test.ts`, `packages/testing/test/leaks.prop.test.ts`); INT-LEAK `apps/server/test/room-harbor.test.ts`                                                                   |
| AC-05 | Pass                                      | E2E-04 `e2e/match.spec.ts`, all three browsers                                                                                                                                                                          |
| AC-06 | Pass                                      | E2E-05 (guest) and the Q-018 designer reload, `e2e/match.spec.ts`, all three browsers                                                                                                                                   |
| AC-07 | Pass                                      | INT-REPLAY `apps/server/test/room-harbor.test.ts`; the replay page in E2E-06                                                                                                                                            |
| AC-08 | Pass                                      | [Node PROP-DET](../games/harbor-market/test/game.prop.test.ts) and [Chromium property replay](../e2e/harbor-determinism.spec.ts) passed 1,000 games each. [E2E-06](../e2e/replay.spec.ts) passed in all three browsers. |
| AC-09 | Pass                                      | INT-ISOLATION `packages/rules-host/test/host-client.test.ts`; the endless move stopped under 1.5 s in `apps/server/test/room-protocol.test.ts`                                                                          |
| AC-10 | Pass                                      | INT-RECOVERY `apps/server/test/room-harbor.test.ts`, `packages/rules-host/test/host-client.test.ts`                                                                                                                     |
| AC-11 | Pass                                      | PERF-01, [docs/perf/perf-01-results.json](perf/perf-01-results.json)                                                                                                                                                    |
| AC-12 | Desktop pass; phones permanently deferred | Desktop Chromium, Firefox and WebKit passed at 360 px and 1440 px. Physical iOS Safari and Android Chrome remain unmeasured.                                                                                            |
| AC-13 | Pass                                      | E2E-07 `e2e/cli.spec.ts` (T19; `bgp dev` in all three browsers here)                                                                                                                                                    |
| AC-14 | Pass                                      | CI-WASM-INVENTORY, `pnpm check:wasm`                                                                                                                                                                                    |
| AC-15 | Pass                                      | [Clean Windows run](#clean-machine-check-ac-15). Frozen install, browser install, startup, sign-in, workspace tests and full desktop browser matrix.                                                                    |

"All three browsers" means desktop Chromium, Firefox and WebKit through Playwright. Desktop
WebKit and synthetic touch do not stand in for iOS or Android (testing.md).

## Handoff runs

### Physical-device table qualification

The owner permanently deferred this run on 2026-11-26, superseding the 2026-11-14 follow-up. The team has no physical-device measurements for the 300-item frame rate, text clarity or touch interaction.

### Last Ferry agent playtest

On 2026-11-26 a designer agent created _Last Ferry_, a two-seat sandbox game. Crews alternate boarding one or two passengers from a public pier. The crew that boards the last passenger wins. Using the local integration fixture, the designer published a version, the two seats were claimed with separate credentials, and each agent chose moves from its seat's view on a separate loopback WebSocket. The coordinator relayed the moves. Match ID: `01a21817-9f2e-74be-a331-0a1d90c43986`.

The designer boarded one of the four passengers and passed. The guest boarded two and passed. The designer boarded the last passenger and ended the match. Both clients observed the same counts after each update and reached sequence 6 with four aboard, the pier empty and the match finished. Under the game's manual scoring rule, the designer won. The playtest exposed a forced win for the starting crew: boarding one leaves three, so either reply lets the first crew finish on its next turn.

This arranged session exercised publishing, invite claims, turn changes and finish propagation through the room server. The [Phase 2 product gate](phase-1-spec.md) still requires evidence of designers independently returning with remote guests.

### Clean-machine check (AC-15)

On a machine with only the prerequisites in [dev-environment.md](dev-environment.md),
follow "Full development environment" through `pnpm dev` and sign in. Stop the app
watchers, leave Compose running, and run `pnpm test`, `pnpm build`, and `pnpm test:e2e`.
Note any step the docs did not cover.

On 2026-11-14, a fresh source checkout on the Windows development machine passed
the frozen install from the existing pnpm cache, `pnpm build`, `pnpm dev` with new
Compose containers and a fresh PostgreSQL volume, and Chromium sign-in. `pnpm test`
passed 798 package tests and 75 tooling tests. `pnpm test:e2e --workers=1` passed 98
tests with four expected skips across Chromium, Firefox and WebKit, including guest
and designer reloads within three seconds. Lint, typecheck and the WASM inventory also
passed. The local PostgreSQL service already owned
5432. The run exposed that `pnpm dev` ignored the documented Compose override, and
the launcher now reads `COMPOSE_FILE`. It also exposed the missing Harbor Market CLI
shim on first install. The guide now invokes the built CLI directly, which served
Harbor Market and passed game validation in the fresh checkout. This run reused the
host's installed Playwright browsers and cached Docker images.

A second Windows run started with an empty pnpm store and a separate Playwright
browser directory. The frozen install downloaded all 202 packages into the new
store. Direct browser downloads intermittently timed out. Playwright installed all
three engines using the official archives, with a temporary loopback mirror for
the downloads that needed to be resumed. PostgreSQL and Keycloak used new containers,
a fresh database volume and the pinned images from the local Docker cache. The
native PostgreSQL service already owned port 5432, so the run used the documented
Compose port override. The clean checkout passed `pnpm dev` and designer sign-in,
`pnpm build`, and `pnpm test` (798 package tests and 75 tooling tests). The final
`pnpm test:e2e` run passed 98 tests with four expected skips across Chromium,
Firefox and WebKit, including guest and designer reloads under three seconds.
Lint, typecheck, and the WASM inventory passed. WebKit also replayed all 300 events
with the expected final hash after the browser worker batches were reduced from
50 to 16 events. Its step timing was 54 ms p50 and 80 ms p95.

An additional check in a new Ubuntu 24.04 WSL 2 guest passed `pnpm dev`, lint, typecheck,
build, and the WASM inventory. The official Playwright image's Firefox could not launch
in the guest container, and the Chromium replay timing and WebKit match checks failed
in that run. The clean Windows run uses native Playwright browsers.

### Ubuntu browser follow-up (2026-11-15)

The failed nested-container run reported Firefox's missing temporary profile, Chromium
replay p95 of 179.4 ms, and a stalled WebKit four-seat match. The follow-up uses the
existing Ubuntu 24.04.5 WSL 2 guest with native Playwright browsers, Node 24.22.1 and
pnpm 11.9.0, a Linux-filesystem checkout, and the pinned Compose services. It reuses the
guest's installed browsers and dependencies; it is a browser regression run, not another
cold-install qualification. All three native engines launch successfully.

The focused native run reproduced a WebKit worker deadline in the fourth seat and a
559 ms replay step. It also established a Chromium replay baseline of 124.8 ms p95.
The renderer now retains unchanged felt, grid, zone graphics and text between snapshots.
Changes to table dimensions, zone declarations, seat angle and drag feedback invalidate
that drawing; teardown clears it. This avoids rebuilding static graphics and text textures
on every move. The worker deadline and replay limits remain unchanged.
Piece artwork is also retained for position, rotation, ordering and interaction-only
changes; changes to its visible face, definition, back, value, highlight, badge or size
still rebuild it. A new three-engine regression compares updated tables with freshly
mounted tables, including visible-to-hidden card transitions. Replay diagnostics now
attach every step's duration and identify the slowest move.

The nightly CI job now explicitly builds the workspace before browser tests, including
the CLI invoked by E2E-07, and retains browser diagnostics on failure. The native Ubuntu
setup and resumed-service troubleshooting are in [dev-environment.md](dev-environment.md).

The focused WebKit verification passed six tests with no retries: three four-seat matches
and three 300-event replays. Replay p95 was 42–47 ms and the worst steps were 268–289 ms
(limits: p95 below 150 ms, every step below 500 ms). Reproduce with:

```bash
pnpm test:e2e e2e/match.spec.ts e2e/replay.spec.ts --project=webkit --grep 'E2E-04|E2E-06' --repeat-each=3
```

The final `pnpm test:e2e` matrix passed **101 tests, with four expected skips**, in
8.8 minutes with retries disabled and no flaky results. The skips are the Chromium-only
CLI publishing and AC-08 property replay cases in Firefox and WebKit. Lint, workspace
typecheck, build, WASM inventory and `pnpm test` also passed (798 package tests plus
75 tooling tests). The pushed renderer commit `f339894` passed the three-engine Windows
visual-baseline job in [CI run 43792476961](https://github.com/JohnnnyTang/onboarding/actions/runs/43792476961).

Final native Ubuntu replay timings (300 steps in each engine):

| Engine   | p50     | p95     | Maximum  |
| -------- | ------- | ------- | -------- |
| Chromium | 55.0 ms | 73.8 ms | 94.9 ms  |
| Firefox  | 17.0 ms | 21.0 ms | 198.0 ms |
| WebKit   | 32.0 ms | 41.0 ms | 280.0 ms |

## Decisions and open questions

- **Q-018** updated with the designer reload measurement.
- **Q-020** and **Q-030** done: the policy allows the service worker and the dev server.
- **Q-031** (new): how the content security policy is delivered, what it allows, and what a
  host must send once hosting is chosen (Q-002).

New dependencies: none (`pixi.js/unsafe-eval` ships with PixiJS). Contract changes: none;
`@bgp/schema` gains a `./jitless` entry point, not a schema change.
