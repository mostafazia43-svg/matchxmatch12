# Click Battle — Architecture

> Telegram Mini App: real-time 1v1 reaction ("click battle") duels, Free / Paid (USDT-TON) / Demo modes.

## 1. Product summary

| | |
|---|---|
| Bot | `@ClickspeedUSDTBot` (configurable via `BOT_USERNAME`) |
| Admin Telegram ID | `901505210` (configurable via `ADMIN_TELEGRAM_IDS`) |
| Modes | `FREE`, `PAID`, `DEMO` |
| Paid tiers | $5 / $10 / $30 / $50 (admin-configurable) |
| Commission | 5% deducted from **each** player's entry (admin-configurable, basis points) |
| Currency | USDT (TON network), 6 decimals |
| Match format | Best of 3 rounds, sudden-death on tie |

## 2. Why this stack (deviation from the brief)

The brief recommended FastAPI + Next.js. This implementation uses **TypeScript everywhere**:

| Layer | Choice | Rationale |
|---|---|---|
| Backend | Node 22+ / **Fastify** + **ws** | One language across bot/server/client; the shared money + game-rule module is imported by all three, so commission math can never drift between layers. |
| Frontend | **React + Vite** (SPA) | Telegram Mini Apps are a single mobile webview — Next.js SSR/routing adds weight with no benefit. Vite ships a ~60KB gz bundle that boots fast on 3G. |
| Bot | **grammY** | Same process family, typed, webhook + long-poll. |
| DB | **PostgreSQL 16** | Relational integrity for the ledger; `NUMERIC`/`BIGINT` money, never floats. |
| Realtime | **Raw WebSocket** | Sub-frame latency control; Socket.IO framing overhead is unnecessary. |
| Cache/queue | **Redis 7** (pluggable) | Matchmaking queue + rate limits. An in-memory driver ships for local dev so the stack runs without Redis. |
| Admin | Routes inside the Mini App, gated server-side | Admins are already Telegram-authenticated; a second app would need a second auth system. |

Money is handled as **`bigint` micro-USDT** (1 USDT = 1_000_000 µ) in application code and `BIGINT` in Postgres. No floating point touches a balance anywhere.

## 3. Topology

```
Telegram client
   |  initData (HMAC-signed)
   v
[ Mini App (React/Vite, nginx) ]  --HTTPS-->  [ API: Fastify ]
   |                                              |
   +--------------- WSS ------------------------->+  ws game gateway
                                                  |
                                    +-------------+--------------+
                                    |             |              |
                              PostgreSQL       Redis        TON provider
                              (ledger,       (queue,       (deposits/
                               matches)      ratelimit)     withdrawals)
                                                  ^
[ Telegram Bot API ] <---- grammY bot ------------+
```

Backend, bot and frontend build from one pnpm/npm workspace and share `@cb/shared`.

## 4. Module map (`packages/backend/src`)

```
config/        env parsing, runtime settings (DB-backed, hot-reloadable)
db/            pool, migrations runner, typed query helpers
modules/
  auth/        Telegram initData validation, JWT sessions
  users/       profile, progression (XP/level), membership gate
  wallet/      balances, ledger, idempotency, deposits, withdrawals
  payments/    TON provider abstraction (mock | tonapi), deposit watcher
  matchmaking/ queue, pairing, AI fallback timer
  game/        authoritative round engine, click validation, anti-cheat
  ai/          bot opponent reaction model
  leaderboard/ ranking snapshot + user rank
  history/     matches + transactions read models
  admin/       dashboard, users, settings, withdrawal review, audit log
  notifications/ outbound Telegram messages
realtime/      ws server, connection registry, latency probe, protocol
lib/           money, errors, logger, ratelimit, ids, time
```

**No file owns two concerns.** Money mutations live only in `wallet/ledger.ts`. Round outcomes are decided only in `game/engine.ts`.

## 5. Server-authoritative model

The client is a renderer. The server is sole authority over: identity, balance, entry fee, commission, prize, match state, round state, click validity, winner, XP, points, rank.

The only client-supplied inputs the server accepts are:
- `initData` (verified by HMAC against `BOT_TOKEN`)
- "I clicked" (a bare signal — carries no timestamp the server trusts)
- queue join / leave intents

See `docs/07-anticheat.md` for the latency-compensation model, which is the one place client timing information is *used* (to be fair to high-ping players) but never *trusted* (it is clamped to a server-measured RTT).

## 6. Data flow: a paid match

1. `POST /api/matchmaking/join {mode:PAID, tier:1000}` → server checks membership gate, balance ≥ entry, then **locks** `entry` in `wallets.locked_micros` (single DB tx, `available >= 0` CHECK).
2. Queue pairs two players → `matches` row `status=COUNTDOWN`, `match_players` rows, `MATCH_FOUND` over WS.
3. Entry lock is **settled**: `MATCH_ENTRY` (-entry) + `COMMISSION` (bookkeeping) ledger rows per player, idempotent on `match:{id}:entry:{userId}`.
4. Rounds 1..N: `ROUND_START` with per-player latency offset → clicks → `ROUND_RESULT`.
5. First to 2 round wins → `MATCH_RESULT`, `PRIZE` credit to winner, idempotent on `match:{id}:prize`.
6. Any abort before step 3 → lock released. Any abort after step 3 → `REFUND` rows for both players.

Every step is one Postgres transaction; the ledger is append-only and every row carries a unique `idempotency_key`.

## 7. Failure posture

| Failure | Behaviour |
|---|---|
| Player disconnects mid-round | 15s reconnect grace (`PLAYER_DISCONNECTED`); forfeit after |
| Server restart mid-match | Matches in non-terminal state are swept to `CANCELLED` + refunded on boot (`game/recovery.ts`) |
| Redis down | Matchmaking falls back to the in-memory driver; rate limits fail-open with a logged warning |
| Postgres down | API returns 503; **no** gameplay proceeds — money state is never advanced optimistically |
| TON provider down | Deposits stay `PENDING` and are re-scanned; withdrawals queue for admin review |

## 8. Documents

| File | Contents |
|---|---|
| `02-database.md` | Full relational schema + constraints |
| `03-api.md` | REST specification |
| `04-websocket.md` | Realtime event protocol |
| `05-auth.md` | Telegram auth + session model |
| `06-wallet.md` | Ledger, idempotency, TON provider contract |
| `07-anticheat.md` | Latency compensation + cheat surface |
| `08-game-engine.md` | 3-round state machine |
| `09-admin.md` | Admin surface + audit |
| `10-deployment.md` | Docker, env, production checklist |
| `11-roadmap.md` | Phased delivery plan |
