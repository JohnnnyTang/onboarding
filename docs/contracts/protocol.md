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
