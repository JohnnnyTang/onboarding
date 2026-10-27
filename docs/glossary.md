# Glossary

Use these terms exactly, in code and in prose.

| Term                                      | Meaning                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Build hash**                            | SHA-256 of a game version's contents (bundle, manifest, components, images). Identifies the version immutably.                                |
| **Component definition** (`ComponentDef`) | A declared kind of physical thing: a card face, a die, a token, a board. Has real-world size, art, and later material and physics properties. |
| **Ctx**                                   | Runtime-managed match context: seats, current and active seats, phase, turn, move number. Not part of game state.                             |
| **Enforced mode**                         | A game whose rules are code; the runtime rejects illegal moves.                                                                               |
| **Event**                                 | One persisted entry in a match's log: an applied move, a manual operation, or a system event (start, end). Numbered by `seq`.                 |
| **Game**                                  | A registered title, owned by a designer, with one or more game versions.                                                                      |
| **Game definition** (`GameDefinition`)    | The default export of a game bundle: setup, moves, turn and phase config, `playerView`, `present`, `interpret`, optional `legalMoves`.        |
| **Game state**                            | The game-specific part of match state, shaped by the game author.                                                                             |
| **Game version**                          | An immutable published build of a game, addressed by its build hash.                                                                          |
| **Game worker**                           | The browser Web Worker that evaluates a game bundle.                                                                                          |
| **Gesture**                               | A renderer-level user action: click an item, drop an item on a zone, select items. Turned into an intent by `interpret`.                      |
| **Guest**                                 | A playtester who joined a match through an invite link, without an account.                                                                   |
| **Hot-seat**                              | A match run entirely in one browser, with seats switched locally. Used by designers for solo testing.                                         |
| **Instance** (item)                       | One physical object on the table, e.g. a specific card. Has an opaque instance ID and refers to a component definition.                       |
| **Intent** (`MoveIntent`)                 | A request to make a move: `{ move, args }`. Becomes an event only if the runtime accepts it.                                                  |
| **Manual operation**                      | A sandbox-mode action on the table model: move, flip, rotate, shuffle, deal, roll.                                                            |
| **Match**                                 | One play session of one game version, with seats, a seed and an event log.                                                                    |
| **Match state**                           | Everything the runtime needs to continue a match: game state, ctx, RNG state, result. Hashable. Never sent to clients.                        |
| **Project**                               | A designer's editable, local-first workspace in IndexedDB. Publishing a project creates a game version.                                       |
| **Rules host**                            | The server-side process that evaluates game bundles in isolation, one sandbox per match.                                                      |
| **Rules sandbox** (`RulesSandbox`)        | The interface over the isolation technology inside the rules host; QuickJS by default (D-008).                                                |
| **WASM inventory**                        | The list of approved WebAssembly modules with reasons and fallbacks: the D-002 table and `wasm-inventory.json`.                               |
| **Sandbox mode**                          | A game without code: the built-in sandbox definition runs it from declarations; players enforce rules themselves through manual operations.   |
| **Seat**                                  | A player position in a match, identified by a `SeatId` string `"0"`, `"1"`, ….                                                                |
| **Seed**                                  | The integer that initializes a match's PRNG.                                                                                                  |
| **seq**                                   | The sequence number of an event within a match, starting at 1. Also stamps every patch sent to clients.                                       |
| **Spike**                                 | A time-boxed experiment that settles an open technology choice with measurements; written up in `docs/spikes/`.                               |
| **Status (of a choice)**                  | Accepted or Decided (build on it), Default (use now, revisit later with evidence), Open (still to be evaluated). See decisions.md.            |
| **State hash**                            | SHA-256 of the canonical JSON of match state (D-006).                                                                                         |
| **Table snapshot** (`TableSnapshot`)      | What a renderer draws: zones and item placements for one seat, produced by `present`.                                                         |
| **View**                                  | What one seat may know: the output of `playerView(state, seat)`.                                                                              |
| **Zone**                                  | A named area on the table: a deck, a hand, a market row, a grid. Has a layout and a visibility rule.                                          |
