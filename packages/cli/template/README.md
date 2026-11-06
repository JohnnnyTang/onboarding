# %GAME_NAME%

A game package for the board game platform, made with `bgp init`. It starts as a small,
complete card game; change the rules, components and art to make it yours.

## The starter game

18 cards numbered 1 to 9, two of each, are shuffled. Every seat gets three. On your turn,
play one card on the pile: if it is higher than the top card, you score its value. Then draw
a card while the deck lasts. When every hand is empty, the highest score wins.

## Files

| Path              | What it is                                                                        |
| ----------------- | --------------------------------------------------------------------------------- |
| `bgp.json`        | The manifest: id, name, version, player count, bundle and components paths        |
| `components.json` | Component declarations (cards and their art) and zones, in millimeters            |
| `assets/`         | Card images (PNG, JPEG, WebP or AVIF; no SVG)                                     |
| `src/rules.ts`    | Setup, moves, end of game, `playerView` (what each seat may see) and `legalMoves` |
| `src/table.ts`    | `present`, `interpret` and `actions`: how a seat's view becomes a table           |
| `src/index.ts`    | The default export, one `GameDefinition`                                          |

## Commands

| Command        | What it does                                                                   |
| -------------- | ------------------------------------------------------------------------------ |
| `bgp dev`      | Serves the game to a hot-seat table in the web app and reloads on every change |
| `bgp validate` | Checks the package, then plays random games for determinism and leaked cards   |
| `bgp build`    | Writes the bundle, `dist/game.js`: one ES module with no imports               |
| `bgp publish`  | Signs you in, uploads a new version and waits until it is ready                |

## Rules for game code

- Rules are pure: no `Date`, `Math.random`, timers, network, storage, DOM or Node APIs.
  Randomness comes only from `random` (in `setup`) and `ctx.random` (in moves).
- State is JSON with safe integers only: no floats, `undefined`, `Map` or `Set`.
- `playerView` removes everything a seat may not know. Give hidden cards opaque IDs from
  `random.id()`, never IDs that reveal the card.
- Import only `@bgp/rules`, plus `@bgp/schema` with `import type`.

The full contract is in the platform's `docs/contracts/rules-api.md`.
