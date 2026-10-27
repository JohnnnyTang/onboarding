# Contract: game manifest and game versions

How a game describes itself and how a version is uploaded. Implemented in `@bgp/schema`; enforced by `bgp validate` and by the server on finalize. Contract version: **`schemaVersion: 1`**.

## `bgp.json`

Lives at the root of a game package (code games) and is generated from a project (sandbox games).

```json
{
  "schemaVersion": 1,
  "id": "harbor-market",
  "name": "Harbor Market",
  "version": "0.1.0",
  "mode": "enforced",
  "sdk": 1,
  "players": { "min": 2, "max": 4 },
  "entry": "dist/game.js",
  "components": "components.json",
  "options": [{ "id": "shortGame", "label": "Short game", "type": "boolean", "default": false }],
  "description": "Trade goods and ship sets before the deck runs out.",
  "authors": ["Example Designer"],
  "license": "All rights reserved"
}
```

| Field                               | Rules                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                     | `1`                                                                                                                                                                                                           |
| `id`                                | Slug, `^[a-z0-9][a-z0-9-]{2,47}$`. Equals the game's slug on the server.                                                                                                                                      |
| `name`                              | 1–80 characters                                                                                                                                                                                               |
| `version`                           | Semantic version, unique per game                                                                                                                                                                             |
| `mode`                              | `"enforced"` (has `entry`) or `"sandbox"` (no `entry`, components file has `zones` and `setup`)                                                                                                               |
| `sdk`                               | Rules API contract version; `1`                                                                                                                                                                               |
| `players`                           | Integers, `1 ≤ min ≤ max ≤ 8`                                                                                                                                                                                 |
| `entry`                             | Enforced mode only: path to the bundle                                                                                                                                                                        |
| `components`                        | Path to the components file                                                                                                                                                                                   |
| `options`                           | Optional. Each option: `id`, `label`, `type` (`"boolean"`, `"integer"`, `"choice"`), `default`; `"integer"` adds `min`/`max`, `"choice"` adds `choices: string[]`. The validated values become `ctx.options`. |
| `description`, `authors`, `license` | Optional, free text (license may be an SPDX identifier)                                                                                                                                                       |

## Version contents and limits

| Item             | Limit                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| `game.js` bundle | ≤ 2 MB, one ES module, **no import statements**, default export is a `GameDefinition` |
| Each image       | ≤ 5 MB; PNG, JPEG, WebP or AVIF                                                       |
| Whole version    | ≤ 100 MB, ≤ 2,000 files                                                               |
| Paths            | Relative, `/`-separated, no `..`, `[A-Za-z0-9._/-]` only                              |

Every `AssetRef` in `components.json` must point to an uploaded file. Game versions may not include `.wasm` files in Phase 1: a game is one JavaScript bundle that runs inside the sandbox, and a game shipping its own WASM would need a separate review path. Revisit if designers need it.

## Upload flow

1. `POST /api/games/:gameId/versions` with the manifest → a **draft** version and its ID.
2. `PUT /api/versions/:versionId/files/<path>` for each file, raw body, header `x-content-sha256` (hex). The server verifies the hash.
3. `POST /api/versions/:versionId/finalize` → the server validates everything (manifest, components, bundle shape, asset references, limits), loads the bundle in a rules host to check that `setup` runs for `players.min` and `players.max`, then computes the build hash and marks the version **ready**. Failure returns every validation error at once.

**Build hash:** SHA-256 over the UTF-8 text formed by sorting all file paths and joining lines `"<path>\t<sha256>\n"`. Two uploads with identical files get the same build hash.

Ready versions are immutable. Fixing a bug means publishing a new version.

## Visibility

`games.visibility` is `private` (owner only), `unlisted` (anyone with a match invite) or `public`. **Phase 1 allows only `private` and `unlisted`** (D-008).
