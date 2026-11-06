# T17 validation: publish, create match, invite

Completed on 2026-11-06 on the `claude/t17-publish-match-invite` branch, based on `064fa83`
(T16 merged).

## Delivered

- **Sandbox matches on the server** (Q-014, Q-017). The room server could not host sandbox
  versions: the rules host ran enforced bundles only. Sandbox builds now carry the
  components file instead of a bundle (`HostBuildSchema` gains a `mode: "sandbox"` variant).
  The host client verifies the file against the build hash, parses it with
  `ComponentsFileSchema` and sends a new, additive `loadSandbox` command. The trusted runtime
  then builds `createSandboxDefinition` inside QuickJS after the usual lockdown, and no game
  module is evaluated. Calls, limits, recovery and per-seat views are unchanged. Finalize
  runs the sandbox setup in the rules host for `players.min` and `players.max`, as it does
  for enforced bundles. See [contracts/rules-host.md](contracts/rules-host.md#builds-and-matches).
- **Sandbox play at the remote table**. `loadGamePackage` downloads only the components file
  of a sandbox version and gives the game worker the built-in sandbox definition, as
  hot-seat play already does. The match page also shows how many moves have been made.
- **Publish** (`/projects/:id/publish`). The project's components and the images they use
  become a version through the upload flow: find the designer's game by the manifest id or
  create it (private or unlisted), create a draft with the chosen version, upload four files
  at a time with their SHA-256, then finalize. Server validation errors are listed with
  their paths. A ready version shows its build hash and a link to create a match.
  `components.json` is written with sorted keys, so an unchanged project re-publishes with
  the same build hash (AC-02). The suggested version is the project's own until it is
  taken, then the next patch. Unused images, card templates and CSV files stay on the
  device. The manifest goes in the draft request body as `bgp.json`'s content; it is not
  uploaded as a file, so the version number does not change the build hash.
- **Game and version pages** (`/games/:gameId`, `/games/:gameId/versions/:versionId`).
  Versions are listed with their status and build hash. A version page shows mode, players,
  the full build hash and the validation errors of a failed version. A ready version has a
  create-match form: seat count within the manifest's range, and the manifest's options
  starting from their defaults.
- **Lobby host controls**. The lobby recognizes the host without a contract change: only the
  owner may read the version's game. The host sees one invite link per open seat with a
  copy button, can take a seat with their own account, can start once the first
  `players.min` seats are taken (the server's rule) and can end the match. Invite links are
  returned only at creation, so the creating tab keeps them in session storage (Q-025).
- **API client**: `createGame`, `updateGame`, `createVersion`, `uploadVersionFile`,
  `finalizeVersion`, `createMatch`, `startMatch` and `abandonMatch`, with bodies, upload
  headers and file paths validated against `HTTP_CONTRACTS` before sending.

No new dependencies. No WASM changes.

## Decisions and open questions

- **Q-014, Q-017** resolved as above. `HOST_PROTOCOL_VERSION` stays 1: the parent and the
  child ship together, and no existing message changed.
- **Q-016** updated: taking a seat in the lobby covers the host who playtests. A host who
  stays seatless can start the match but not watch it.
- **Q-025** (new): invite links live in the creating tab's session storage. Other tabs show a
  notice instead of the links. A future owner-only endpoint could reissue an unclaimed
  seat's invite.

## Checks

| Command                     | Evidence                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                | 10 build tasks pass                                                                                                          |
| `pnpm typecheck`            | All tasks plus root tooling pass                                                                                             |
| `pnpm lint`                 | Biome and package-boundary checks pass                                                                                       |
| `pnpm test`                 | 17 tasks and 66 tooling tests pass: 173 schema, 92 rules, 72 rules-host, 159 web, 128 server (`bgp_test`), 21 card-generator |
| `pnpm check:wasm`           | Passes; only the rules host's QuickJS module, the web output has none                                                        |
| `pnpm test:e2e --workers=1` | 69 of 69 pass in Chromium, Firefox and WebKit (7.4 min), including E2E-01 to E2E-05                                          |

PostgreSQL ran on port 15432 because a native PostgreSQL holds 5432 on this machine.

**Done-when check.** `e2e/publish.spec.ts` runs E2E-02 and E2E-03 in Chromium, Firefox and
WebKit. A small sandbox project (two card types, a die, a deck, two free zones and a hand
per seat) is seeded into the host's IndexedDB. designer2 signs in from the Publish section
and lands back on it, publishes the project as an unlisted game and sees version 0.1.0
ready with its build hash. Publishing again gives version 0.1.1 with the same hash, and the
game page lists both as ready. From the version page the host creates a 3-seat match and
takes seat 1 in the lobby. Two guests in separate contexts join by the copied invite links,
the host's lobby shows the seats taken, and the host starts the match. All three reach the
table. Then each operation reaches all three seats, checked by each page's move count:

- the host deals one card to each hand, and each seat knows only its own card;
- a guest flips the top card of the deck, and everyone sees it face up;
- the other guest shuffles the deck;
- a guest rolls the die;
- the host drags the die from one zone to another, and everyone sees it there.

No page shows an error.

## Not covered here

- Invite links show only in the tab that created the match (Q-025), and no endpoint
  reissues a seat's invite yet.
- A seatless host cannot watch the match (Q-016).
- A designer who reloads signs in again through the Keycloak session (Q-018). The publish
  form and lobby work again once they are back.
- Publishing does not show upload progress per byte, only per file.
