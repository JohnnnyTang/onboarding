# Contract: WebSocket protocol

Real-time messages between the web app and the room server. Implemented as Zod schemas in `@bgp/schema`. **`PROTOCOL_VERSION = 1`**.

## Connection

- Endpoint: `wss://<host>/ws` (`ws://` in local development).
- Text frames, one JSON object per frame, each with a type field `t`.
- The client's first message must be `hello` within 10 seconds, or the server closes the socket.
- One live connection per seat per match. A new `hello` for a taken seat replaces the old connection, which receives `error` `SEAT_TAKEN_OVER` (fatal).

## Client → server

| `t`         | Fields                                                                           | Notes                                                                |
| ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `hello`     | `protocol: 1`, `matchId`, `auth: { kind: "user" \| "guest", token }`, `lastSeq?` | User token = OIDC access token; guest token from invite claim        |
| `move`      | `clientSeq: number`, `intent: MoveIntent`                                        | `clientSeq` increases per connection                                 |
| `resync`    | —                                                                                | Request a full `snapshot`                                            |
| `ephemeral` | `data: { kind: "drag", item, pos_mm } \| { kind: "pointer", pos_mm }`            | Not persisted, not part of state; relayed to others; ≤ 20 per second |
| `chat`      | `text` (1–500 chars)                                                             | ≤ 1 per second                                                       |
| `ping`      | `ts`                                                                             | Server answers `pong`                                                |

## Server → client

| `t`         | Fields                                                                                                                             | Notes                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `welcome`   | `protocol: 1`, `seat: SeatId \| null`, `match: { id, status, versionId, buildHash, seats: SeatInfo[] }`, `seq`, `view: ClientView` | First message after a valid `hello`            |
| `patch`     | `seq`, `ops: JsonPatchOperation[]`, `cause: { seat, clientSeq?, move }`                                                            | RFC 6902 ops against this seat's previous view |
| `snapshot`  | `seq`, `view: ClientView`                                                                                                          | After `resync`, recovery or a large change     |
| `rejected`  | `clientSeq`, `code`, `gameCode?`, `message`                                                                                        | The move was not applied                       |
| `presence`  | `seats: SeatInfo[]`                                                                                                                | On join, leave, reconnect                      |
| `ephemeral` | `from: SeatId`, `data`                                                                                                             | Relayed from another seat                      |
| `chat`      | `from: SeatId`, `name`, `text`, `at` (ISO time)                                                                                    |                                                |
| `ended`     | `result: GameResult`                                                                                                               | Also reflected in the view                     |
| `error`     | `code`, `message`, `fatal: boolean`                                                                                                | Fatal errors are followed by close             |
| `pong`      | `ts`                                                                                                                               |                                                |

```ts
export interface SeatInfo {
  seat: SeatId;
  name: string;
  connected: boolean;
  guest: boolean;
}
```

## Ordering and consistency

- The server applies moves for one match strictly one at a time, in arrival order.
- `seq` equals the event number of the last accepted event in the view. A `patch` always has `seq = previous seq + 1`.
- A client that sees a gap, fails to apply a patch, or reconnects sends `resync` (or `hello` with `lastSeq`) and receives a `snapshot`.
- `patch.ops` are computed per connection from the last view sent to that connection. They never contain data outside that seat's view.
- A match event is stored in PostgreSQL before any patch for it is sent.

## Rate limits

Per connection: `move` ≤ 10 per second, `ephemeral` ≤ 20 per second, `chat` ≤ 1 per second. Excess messages get `error` `RATE_LIMITED` (not fatal) and are dropped.

## Server behavior (T11)

How the room server in `apps/server` applies the rules above. Message shapes are unchanged.

- **Frames.** Text frames up to 64 KiB; larger frames close the socket (1009). Fatal errors close with
  1008, or 1011 for `INTERNAL`. A server shutdown closes with 1001 and no `error`; clients reconnect.
- **`hello` checks, in order:** protocol (`PROTOCOL_VERSION`), schema (`BAD_MESSAGE`), token
  (`UNAUTHORIZED`; `auth.kind` must match the token type), a guest token's match (`FORBIDDEN`), the
  match (`MATCH_NOT_FOUND`), a claimed seat held by the caller (`FORBIDDEN`), then status `active`
  (`MATCH_NOT_ACTIVE`, also for finished matches, whose replay is served over HTTP). Every error before
  `welcome` is fatal, as is a missing `hello` after 10 seconds (`BAD_MESSAGE`). Tokens are checked at
  `hello` only. Owners without a seat are not admitted yet (Q-016); sandbox matches are not hosted yet
  (Q-017).
- **`welcome`** always carries the full current view, so no `snapshot` follows it; `lastSeq` is
  accepted but not needed.
- **After `welcome`:** an invalid message or a second `hello` gets a non-fatal `BAD_MESSAGE` and is
  dropped. A `move` whose `clientSeq` does not increase gets `rejected` `BAD_MESSAGE`.
- **Moves.** `patch.cause.clientSeq` is sent only to the mover's own connection. A change whose patch
  exceeds 8 KiB and is longer than the view is sent as a `snapshot` (no `cause`; it still acknowledges the
  move). `GAME_ERROR` always has the message `Game execution failed`; the move is discarded, never
  retried. After `ended`, moves get `rejected` `MATCH_FINISHED`. Abandoning an active match sends every
  connection a fatal `MATCH_NOT_ACTIVE`.
- **Recovery.** When a match's rules host process dies, or the server restarts, the room rebuilds the
  match from its latest stored snapshot plus later events, checks the stored hash where one exists for
  the current `seq`, and sends each connection a `snapshot` at the unchanged `seq`. A failed rebuild
  closes every connection with `INTERNAL`.
- **Presence** goes to every connection when a seat connects, disconnects or is taken over. HTTP match
  summaries report the same `connected` flags.
- **Chat** goes to every connection, the sender included, and is not stored.
- **Ephemeral** messages go to the other connections only. A `drag` keeps its `item` only for seats whose
  current view already contains that ID; other seats receive it as a `pointer` at the same position, so
  dragging a hidden card never reveals which card it is.

## Error codes

Shared by `rejected`, `error` and HTTP error bodies.

| Code                | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `PROTOCOL_VERSION`  | Client protocol not supported (fatal)                                |
| `BAD_MESSAGE`       | Message failed schema validation                                     |
| `UNAUTHORIZED`      | Missing, expired or invalid token (fatal on `hello`)                 |
| `FORBIDDEN`         | Valid identity, no right to this match or seat                       |
| `MATCH_NOT_FOUND`   | Unknown match                                                        |
| `MATCH_NOT_ACTIVE`  | Match is in lobby, finished or abandoned                             |
| `MATCH_FINISHED`    | Move sent after the end                                              |
| `NOT_YOUR_TURN`     | Seat not active and move not `anySeat`                               |
| `MOVE_NOT_ALLOWED`  | Move not allowed in the current phase                                |
| `UNKNOWN_MOVE`      | No such move                                                         |
| `INVALID_ARGS`      | Args failed `parse`, or a sandbox op is invalid                      |
| `INVALID_MOVE`      | The game rejected the move; `gameCode` carries the game's code       |
| `GAME_ERROR`        | Game code threw, timed out, or produced invalid state                |
| `RATE_LIMITED`      | Too many messages                                                    |
| `SEAT_TAKEN_OVER`   | Another connection took this seat (fatal)                            |
| `VALIDATION_FAILED` | HTTP only: upload or finalize validation failed; body lists `errors` |
| `NOT_FOUND`         | HTTP only: resource does not exist                                   |
| `CONFLICT`          | HTTP only: e.g. duplicate slug or version                            |
| `INTERNAL`          | Unexpected server error; details only in server logs                 |

Messages sent to clients never include stack traces, match state or another seat's data.

## Validation examples

Sequence numbers and `ts` (milliseconds) are nonnegative safe integers; accepted event
sequences start at 1. A client may start its increasing `clientSeq` at 0. Positions are
integer millimeters. Schemas check message structure; connection order, sequence gaps,
patch application, rate limits and seat permissions are room-server checks (T11).

<!-- schema: ClientMessageSchema -->
```json
{
  "t": "hello",
  "protocol": 1,
  "matchId": "match-1",
  "auth": { "kind": "guest", "token": "guest-token" },
  "lastSeq": 0
}
```

<!-- schema: ServerMessageSchema -->
```json
{
  "t": "patch",
  "seq": 1,
  "ops": [{ "op": "replace", "path": "/game/deckCount", "value": 3 }],
  "cause": { "seat": "0", "clientSeq": 0, "move": "draw" }
}
```
