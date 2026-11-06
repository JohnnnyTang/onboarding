# Performance checks

## PERF-01 (AC-11)

```sh
pnpm build            # the rules host bundle
pnpm perf             # 20 matches × 4 seats; fails if p95 >= 200 ms
pnpm perf --out docs/perf/perf-01-results.json
```

`perf-01.ts` starts its own API and room server (`apps/server`, the rules host in QuickJS) as
a separate process on loopback, with a local token issuer in place of Keycloak. It needs only
PostgreSQL: it creates and migrates a `bgp_perf` database beside `DATABASE_URL` (or uses
`PERF_DATABASE_URL`, whose name must end in `_perf`).

It publishes Harbor Market through the HTTP API, creates the matches, claims every seat as a
guest and starts them. Then each match is played by scripted clients over the WebSocket
protocol, all matches at once. The clients keep their views current with the web app's own
patch code (`applyViewPatch`) and choose moves from their own view only. Each match swaps
cards `--moves` times, then plays to the end. A move's round trip is the time from sending
`move` to receiving the mover's own `patch` (`cause.clientSeq`).

| Flag         | Default | Meaning                                                                  |
| ------------ | ------- | ------------------------------------------------------------------------ |
| `--matches`  | 20      | Concurrent matches                                                       |
| `--seats`    | 4       | Seats per match (2–4)                                                    |
| `--moves`    | 150     | Swaps per match before playing to the end                                |
| `--think-ms` | 250     | Pause between a patch and the match's next move (rate limit still holds) |
| `--out`      | —       | Write the JSON result to this file                                       |

The process exits with 1 if p95 is not under 200 ms or any move is rejected, times out or
errors. The nightly CI job runs it and keeps the result as an artifact. The committed
[results](../../docs/perf/perf-01-results.json) are the T20 handoff run; see
[t20-validation.md](../../docs/t20-validation.md).
