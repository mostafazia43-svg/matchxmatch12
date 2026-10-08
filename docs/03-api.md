# REST API

Base URL: `PUBLIC_API_URL`, `/api` prefix. All responses use one envelope:

```jsonc
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "INSUFFICIENT_BALANCE", "message": "…", "details": { } } }
```

Auth: `Authorization: Bearer <jwt>` on everything except `/api/config`,
`/api/auth/*` and `/health`.

**Money on the wire is a decimal string of micro-USDT** (`"9500000"` = $9.50).
JSON has no bigint, and a float would lose micros.

## Error codes

`UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `VALIDATION` `RATE_LIMITED` `MAINTENANCE`
`BLOCKED` `MEMBERSHIP_REQUIRED` `MODE_DISABLED` `INVALID_TIER`
`INSUFFICIENT_BALANCE` `ALREADY_QUEUED` `ALREADY_IN_MATCH` `MATCH_NOT_FOUND`
`NOT_A_PARTICIPANT` `INVALID_STATE` `DUPLICATE_REQUEST` `WITHDRAWALS_DISABLED`
`DEPOSITS_DISABLED` `AMOUNT_TOO_SMALL` `INVALID_ADDRESS` `PROVIDER_UNAVAILABLE`
`INTERNAL`

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | 503 when the database is down — never reports healthy without it |
| GET | `/ready` | readiness + maintenance flag |
| GET | `/api/config` | non-secret config: modes, tiers, commission, limits |

## Auth

### POST `/api/auth/telegram`

Rate limit: 20/min per IP.

```jsonc
// request
{ "initData": "<raw Telegram WebApp initData>" }

// response
{
  "token": "...",
  "expiresAt": "2026-08-26T10:00:00.000Z",
  "isNewUser": false,
  "user": {
    "id": "uuid", "telegramId": "901505210", "username": "player",
    "displayName": "player", "photoUrl": null, "level": 4, "isAdmin": true
  },
  "config": { }
}
```

The `initData` HMAC is verified against `BOT_TOKEN` and its `auth_date` is
age-checked. Identity is read only from the verified payload — never from a
separate request field.

### POST `/api/auth/dev`

Development only. Returns 403 unless `ALLOW_DEV_AUTH=true` **and**
`NODE_ENV != production`.

### POST `/api/auth/logout`

Revokes the current session server-side.

## Player

| Method | Path | Returns |
|---|---|---|
| GET | `/api/me` | user, progress, wallet, rank, membership, `activeMatchId` |
| GET | `/api/leaderboard?limit=` | `{ entries, me }` — `me` is included even outside the top N |

## Matchmaking

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/matchmaking/join` | `{ mode, entryMicros? }` | locks funds for PAID; 30/min |
| POST | `/api/matchmaking/leave` | — | releases the lock |
| POST | `/api/matchmaking/accept-ai` | — | accepts the offer made after a timeout |
| GET | `/api/matchmaking/status` | — | `{ queued, activeMatchId, timeoutMs }` |

`join` returns `{ state: "WAITING" }` or `{ state: "MATCHED", matchId }`.
Everything after that arrives over the WebSocket.

## Matches

| Method | Path | Notes |
|---|---|---|
| GET | `/api/matches?limit=&mode=` | your match history |
| GET | `/api/matches/:id` | full match view; participants only while the match is live |

## Wallet

| Method | Path | Body |
|---|---|---|
| GET | `/api/wallet` | — |
| GET | `/api/wallet/transactions?limit=&before=&types=` | — |
| GET | `/api/wallet/deposits` | — |
| GET | `/api/wallet/withdrawals` | — |
| POST | `/api/wallet/address` | `{ address }` |
| POST | `/api/wallet/withdraw` | `{ amountMicros, toAddress, requestKey }` — 5/hour |

`requestKey` is client-generated and makes the withdrawal idempotent: a
double-tap yields `DUPLICATE_REQUEST`, not two withdrawals.

`GET /api/wallet` includes `depositAddress` and `depositMemo`. The memo is how
an on-chain transfer is attributed to a player; without it a deposit lands in
manual review.

## Admin

Every route requires an admin Telegram ID and writes an `admin_actions` row.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/dashboard` | users, matches, money, alerts, provider status |
| GET | `/api/admin/users?q=&limit=&blocked=` | search |
| GET | `/api/admin/users/:id` | profile + transactions + matches + flags |
| POST | `/api/admin/users/:id/block` | `{ blocked, reason }` — also revokes sessions |
| POST | `/api/admin/users/:id/adjust` | `{ amountMicros, reason, requestKey }` |
| GET | `/api/admin/withdrawals?status=` | review queue |
| POST | `/api/admin/withdrawals/:id/review` | `{ decision, note?, txHash? }` |
| GET | `/api/admin/matches?status=&mode=&limit=` | match browser |
| POST | `/api/admin/matches/:id/cancel` | cancel + refund |
| GET | `/api/admin/matches/:id/events` | full server event log for a match |
| GET | `/api/admin/suspicious?resolved=` | security flags |
| POST | `/api/admin/suspicious/:id/resolve` | close a flag |
| GET | `/api/admin/audit` | admin action log |
| GET | `/api/admin/settings` | all runtime settings |
| PUT | `/api/admin/settings` | `{ key, value }` — validated against the schema |
| POST | `/api/admin/simulate-deposit` | mock provider only |

Balance adjustment writes an `ADMIN_ADJUSTMENT` ledger row with a mandatory
reason. It is never a direct UPDATE on the balance.
