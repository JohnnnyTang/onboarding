# Contract: `bgp dev` server

How `bgp dev` serves a game package under development to the web app's hot-seat page
(`/dev`). Implemented in `@bgp/schema` (`DevGameResponseSchema`, `DevBuildEventSchema`), the
CLI (`packages/cli/src/dev.ts`) and the web app (`apps/web/src/dev/`). Version field:
**`protocol: 1`** (`DEV_SERVER_PROTOCOL`). The CLI and the web app ship together, so a change
that breaks either side bumps it.

## Where it runs

`bgp dev [dir]` listens on `127.0.0.1` (port 4400 by default, `--port`). It prints the page to
open: `<web>/dev?game=<server origin>`, where `<web>` is the web app (default
`http://localhost:5173`, `--web`). Responses carry `Access-Control-Allow-Origin` for that web
origin only, so other sites the developer visits cannot read the package.

The page accepts only a plain `http:` origin on a loopback host (`localhost`, `127.0.0.1`,
`[::1]`) as `game`, without a path, query or credentials. Game code from it runs in the game
worker under the same lockdown as published games; the page never evaluates it.

## Endpoints

| Method and path | Response                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `GET /game`     | `DevGameResponse` (JSON, `cache-control: no-store`)                                                 |
| `GET /events`   | Server-sent events: `event: build` with `DevBuildEvent` data after every rebuild; comments as pings |
| `GET /<asset>`  | A file the components reference (`AssetRef`), with a type from its extension; 404 for anything else |

The server rebuilds when any file in the package changes (except `dist/` and
`node_modules/`), rereading `bgp.json` and the components file. `buildId` increases with every
rebuild. If the manifest or components file no longer parses, the last good ones are kept and
`errors` says what is wrong.

<!-- schema: DevGameResponseSchema -->
```json
{
  "protocol": 1,
  "buildId": 3,
  "manifest": {
    "schemaVersion": 1,
    "id": "my-game",
    "name": "My Game",
    "version": "0.1.0",
    "mode": "enforced",
    "sdk": 1,
    "players": { "min": 2, "max": 4 },
    "entry": "dist/game.js",
    "components": "components.json"
  },
  "components": {
    "schemaVersion": 1,
    "defs": [{ "id": "card-back", "kind": "cardBack", "image": "assets/card-back.png" }]
  },
  "source": "var game = { sdk: 1 };\nexport { game as default };\n",
  "errors": []
}
```

For an enforced game, `source` is the bundle `bgp build` would write, or `null` with `errors`
(each a `ValidationError`) while the build fails. Sandbox games have `source: null`.

<!-- schema: DevBuildEventSchema -->
```json
{ "buildId": 4 }
```

## Hot reload

On each `build` event the page fetches `/game` again. With a bundle, it starts a new game
worker with it and replays the current hot-seat match's init and accepted events. If the
replay no longer fits the changed rules (a rejected event), it starts a new game and says so.
While the build is broken, the page keeps the last working game and shows the errors. The
match lives in the tab (session storage), not in the projects database.
