# T15 validation: local-first projects and hot-seat play

Completed on 2026-11-04 on the `claude/t15-local-projects` branch, based on `44e7f4e` (T14
merged).

## Delivered

- **IndexedDB stores** (`apps/web/src/projects/project-store.ts`). The `bgp` database has
  `projects`, `projectAssets` and `hotseatMatches` as in [data-model.md](data-model.md#browser-indexeddb-bgp-database),
  behind a small `ProjectStore` interface over `idb` (the tech-stack default, D-015). Storage
  is a trust boundary: `LocalProjectSchema`, `ProjectAssetInfoSchema` and
  `HotSeatMatchRecordSchema` were added to `@bgp/schema`, every record is validated when it
  is written and when it is read, and unreadable records are counted on the project list,
  never shown. A project's manifest and components always form a valid sandbox package, so
  any saved project can be played. Deleting a project removes its images and hot-seat
  matches in one transaction. The browser is asked to keep the data (`storage.persist`).
- **Project list** (`/projects`): create by name (the manifest id is a slug of it), open,
  play, delete with an inline confirmation (no browser dialogs).
- **Project editor** (`/projects/:id[/:section]`): details (name, player counts,
  description); image import (PNG, JPEG, WebP, AVIF recognized by their bytes, not the file
  name; at most 5 MB; SHA-256 recorded; safe unique `assets/...` paths); components of every
  Phase 1 kind (card, card back, token, die, board, piece) with their sizes in mm and images
  (a first card brings a card back; a back in use cannot be removed); missing images are
  listed and drawn as labeled placeholders.
- **Zone editor on the table**: a top-down SVG of the table in millimeters, seat 1 at the
  bottom. Drag on empty table to draw a zone, drag a zone to move it, drag a corner to resize
  it (5 mm snap). The form sets label, layout (with grid size), owner (shared, each seat, or
  one seat), visibility and exact coordinates; arrow keys move the selected zone. The table
  grows with the zones as the sandbox computes it (Q-009).
- **Setup editor**: lines of component, zone (including each seat's copy of an "each" zone),
  count, face and shuffle.
- **Hot-seat play** (`/projects/:id/play`). The game worker now accepts a game source: a
  bundle, or the built-in sandbox definition for the components file (the worker is locked
  down the same way for both). `hotSeatCreate` takes the stored events and rebuilds the
  match with `replay`. The page resumes the project's latest match (or starts over, saying
  so, when its events no longer fit the project; Q-022), stores every accepted event, and
  offers "New game" with any allowed player count. The seat switcher shows each seat's own
  view; "All seats" merges the seats' snapshots, so it shows what any seat may see and
  nothing more, read-only (Q-021). Rejected moves show the game's message.
- **Sandbox gestures and buttons** (`@bgp/rules`). The sandbox definition now has
  `interpret` (a drop becomes `move`) and `actions` (Flip, Rotate, Roll, Shuffle, Deal 1 to
  each hand, End turn), documented in [components-and-table.md](contracts/components-and-table.md#platform-gestures-and-buttons).
  Both read only the seat's view. Dealing into owner-visible zones deals face up, which only
  the owner sees; otherwise the table draws the owner's own cards as backs. T17's remote
  sandbox matches can reuse both.
- **Offline** (Q-020). A hand-written service worker, production builds only, caches every
  file of the build on install (the build injects the list and a content hash), serves them
  from the cache, and sends navigations to the network first with the cached app as
  fallback. Cross-origin requests are untouched; nothing is cached at runtime. `pnpm dev`
  registers no service worker.

## Things found and fixed on the way

- **Lost edits.** Editors built each change from the project their last render saw, and
  React runs effects after paint, so a late render of an older save could undo a newer edit
  (in WebKit the "face down" of a setup line was lost in 5 of 8 scripted runs). Now every
  edit is a change function applied to the newest saved project in one queue per tab, and
  the setup editor's draft is authoritative while it is open. The same queue makes the play
  page read a project only after pending edits are stored.
- **WebKit drags.** Pointer capture with React's delegated handlers delivered no moves in
  Playwright's WebKit, so zones could not be drawn. Drags now follow window listeners, and
  screen-to-table conversion is plain arithmetic from the box and the viewBox (unit tested).
- **Slugs** turned accented letters into dashes ("Été" → "e-te"); accents are now dropped.
- **WebKit service workers on Windows** never finish registering under the deep
  `test-results` folder (path length). The E2E profile lives in a short temp directory.

## Checks

| Command                     | Evidence                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm build`                | 10 build tasks pass; the web build emits `/sw.js` with the precache list                       |
| `pnpm typecheck`            | All tasks plus root tooling pass                                                               |
| `pnpm lint`                 | Biome and package-boundary checks pass                                                         |
| `pnpm test`                 | 17 tasks and 56 tooling tests pass: 125 web, 92 rules, 151 schema, 127 server (`bgp_test`)     |
| `pnpm check:wasm`           | Passes; the web output has no WASM                                                             |
| `pnpm test:e2e --workers=1` | 63 of 63 pass in Chromium, Firefox and WebKit (5.2 min), including E2E-04, E2E-05 and lockdown |

`e2e/projects.spec.ts` also passed 4 times in a row in each browser. PostgreSQL ran on port
15432 because a native PostgreSQL holds 5432 on this machine.

**Done-when check.** `e2e/projects.spec.ts` runs E2E-01 except card generation in each
browser, as a designer would, through the page only. It starts a browser with a profile on
disk, opens `/projects` once online so the service worker installs, then disables the
network and reloads (the app comes from the cache). Offline from there, it creates a
project, imports two images, adds a card (with its back) and a die, draws a zone with the
mouse and resizes it by a corner, adds a market and an owner-only hand for each seat, and
sets up ten shuffled face-down cards and the die. On the hot-seat page, seat 1 selects the
deck with the keyboard and deals one card to each hand; seat 1 then sees its own card and
the other hand's back, seat 2 rolls the die and sees the reverse, and "All seats" shows both
hands' cards while the deck stays hidden. No request from the page failed. The browser is
then closed and started again with the same profile, still offline: the project is listed,
and its hot-seat game resumes with both moves and the same hidden hands. Card generation
from a template and CSV (10 cards) is T16's part of E2E-01.

Unit tests cover the store (against `fake-indexeddb`), the project model (every component
kind, cascading removals, seat checks, slugs), image recognition and naming, zone geometry,
the hot-seat controller over the real worker entry (dealing, seat views, the merged view,
rejections, resuming, starting over, new games), the merged view itself, the worker's
sandbox source and resume, and the sandbox `interpret` and `actions` (every produced intent
is accepted by `applyIntent`; buttons never name an item in another seat's private zone).

## Not covered here

- Card templates and CSV sources are stored as JSON arrays; T16 defines their shape.
- A die's face labels and images, and a token's back image, are not editable yet; the
  defaults apply (labels 1..n; back = front).
- The all-seats view is read-only, and an enforced game with per-seat opaque IDs would show
  an item more than once in it (Q-021).
- Two tabs editing the same project overwrite each other's changes (no live sync, D-015).
- The first visit must be online for the service worker to install. Its interaction with a
  content security policy is T20's (Q-020).
- In `pnpm dev`, Vite's hot-reload client inside the locked-down game worker throws "Not
  available to game code" on hot updates. It predates T15 and does not exist in production
  builds.
