# Harbor Market

The enforced reference game for the Phase 1 headless core. Rules and behavior are
specified in [reference-game.md](../../docs/reference-game.md).

- `src/index.ts` exports the complete `GameDefinition` as its default export.
- `bgp.json` declares 2–4 players and the optional `shortGame` flag.
- `components.json` declares 15 goods cards, their shared back and the tide die.
- `pnpm --filter harbor-market... build` builds dependencies, TypeScript declarations,
  and the import-free ES module at `dist/game.js` (the manifest entry).
- `pnpm --filter harbor-market test` runs focused rules/presentation tests and 20
  generated games per property. With `BGP_PROPERTY_RUNS=1000`, it checks 1,000
  complete deterministic games and 200 complete games for leaks. Every game uses
  the public `@bgp/testing` random bot, with separate seeded bot randomness.

Image paths are reserved for T16 card-generator output. Missing images render as
labeled placeholders; the package cannot pass upload asset-existence checks until
those files are supplied. No art or WASM is bundled here.

The game uses only its filtered view for presentation and controls. Other hands
use count-derived `x:<seat>:<index>` placeholders, never authoritative card IDs.
The table uses the optional snapshot zone rotation to place side-seat fans and
rows clockwise. Until presentation receives player names, HUD labels use numbered
seats. Finished games and spectators have no move controls.
