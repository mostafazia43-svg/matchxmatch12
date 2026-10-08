# WebSocket protocol

Endpoint: `wss://<host>/ws` · JSON frames · max payload 4KB.
Types live in `packages/shared/src/protocol.ts` and are shared by both sides,
so an event cannot mean one thing on the server and another on the client.

## Handshake

An unauthenticated socket may send exactly one message — `HELLO` — within 10
seconds, or it is closed. An anonymous connection cannot sit and consume
resources.

```jsonc
--> { "t": "HELLO", "token": "<jwt>", "v": 1 }
<-- { "t": "WELCOME", "userId": "...", "serverTime": 1700000000000, "v": 1 }
```

Close codes: `4001` auth failed or session revoked · `4003` account blocked ·
`4008` too many connections · `4029` flooding · `4000` pong timeout.

## Latency probe

```jsonc
<-- { "t": "PING", "nonce": 7, "serverTime": 1700000000000 }
--> { "t": "PONG", "nonce": 7 }
<-- { "t": "LATENCY", "rttMs": 84 }
```

Reply immediately. The server takes the **minimum** of recent samples as your
RTT, and that is what your latency compensation is based on — delaying a pong
makes your connection look worse, not better. See `docs/07-anticheat.md`.

## Client → server

| Event | Payload | Notes |
|---|---|---|
| `HELLO` | `token`, `v` | first frame only |
| `PONG` | `nonce` | |
| `QUEUE_JOIN` | `mode`, `entryMicros?` | |
| `QUEUE_LEAVE` | — | |
| `AI_ACCEPT` | — | accepts an `AI_OFFER` |
| `MATCH_SUBSCRIBE` | `matchId` | participants only |
| `CLICK` | `matchId`, `roundNo`, `seq` | **carries no timing data** |
| `FORFEIT` | `matchId` | |

## Server → client

| Event | Meaning |
|---|---|
| `QUEUE_STATE` | `WAITING` / `CANCELLED`, with wait time and timeout |
| `QUEUE_ERROR` | could not queue, or no opponent found |
| `AI_OFFER` | AI fallback offered after a matchmaking timeout |
| `MATCH_FOUND` | full `MatchView`, rendered per-recipient (`isSelf` is correct for each) |
| `COUNTDOWN_START` | round starting; `countdownMs` for the 3-2-1 |
| `COUNTDOWN_TICK` | `3`, `2`, `1` |
| `ROUND_ARMED` | countdown finished — button armed, GO not yet live |
| `ROUND_START` | **GO.** Sent at the instant, never in advance |
| `CLICK_ACCEPTED` | your server-measured `reactionMs` |
| `CLICK_REJECTED` | `EARLY` / `DUPLICATE` / `CLOSED` / `TOO_FAST` |
| `ROUND_RESULT` | winner, reason, both reaction times, running score |
| `NEXT_ROUND` | next round number and the gap before it |
| `MATCH_RESULT` | final view, prize, XP, points, level-up |
| `MATCH_CANCELLED` | reason and refund amount |
| `BALANCE_UPDATED` | new available/locked, with a reason |
| `PLAYER_DISCONNECTED` | opponent dropped; grace window before forfeit |
| `PLAYER_RECONNECTED` | opponent is back |
| `ERROR` | code + message |

## Round timeline

```
COUNTDOWN_START  ──►  COUNTDOWN_TICK 3 ─ 2 ─ 1
                          │
                          ▼        (countdownMs elapsed)
                     ROUND_ARMED   ← clicking here is a FALSE START
                          │
                          │  random 300-2000ms, never announced
                          ▼
                     ROUND_START   ← GO. click now.
                          │
                     CLICK ──► CLICK_ACCEPTED { reactionMs }
                          │
                          ▼        (both clicked, or deadline reached)
                     ROUND_RESULT
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         NEXT_ROUND              MATCH_RESULT
```

## Reconnection

The client reconnects with exponential backoff plus jitter, so a server restart
does not summon every client at the same millisecond.

On `HELLO` the server re-sends the live `MatchView` if the player is mid-match
and cancels their forfeit timer. A player has `game.disconnect_grace_ms` (15s
by default) to return before forfeiting.

Multiple sockets per user are allowed (phone + desktop) up to
`WS_MAX_CONNECTIONS_PER_USER`; a disconnect only counts when the *last* one
closes.
