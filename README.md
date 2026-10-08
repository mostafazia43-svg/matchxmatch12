# ⚡ Click Battle

A Telegram Mini App: real-time 1v1 reaction duels. Two players, three rounds,
one button. Free for points, or paid in USDT on TON.

> **Real-money product.** Before taking deposits, get legal advice on licensing,
> KYC/AML and geo-restriction in your target jurisdictions. See
> [`docs/10-deployment.md`](docs/10-deployment.md).

---

## How it plays

1. Pick **Free**, **Paid** or **Demo** and get matched with another player.
2. A 3-2-1 countdown runs — then you wait.
3. **GO** appears at a moment you cannot predict. Tap first to win the round.
4. Tapping before GO loses the round outright.
5. First to win 2 of 3 rounds is champion.

In a paid match each player pays the entry, 5% is taken from **each** entry, and
the champion takes the rest:

| Entry | Fee each | Champion receives |
|---|---|---|
| $5 | $0.25 | **$9.50** |
| $10 | $0.50 | **$19.00** |
| $30 | $1.50 | **$57.00** |
| $50 | $2.50 | **$95.00** |

---

## Quick start

```bash
cp .env.example .env
# set BOT_TOKEN, ADMIN_TELEGRAM_IDS, JWT_SECRET, MINI_APP_URL

docker compose up -d --build
docker compose logs -f backend
```

The Mini App is on `:8081`, the API on `:8080`. Migrations run at boot.

### Local development

```bash
npm install
npm run build -w @cb/shared        # other packages import its build output

docker compose up -d postgres redis
npm run migrate

npm run dev        # backend  :8080
npm run dev:web    # mini app :5173  (proxies /api and /ws to the backend)
npm run dev:bot    # telegram bot
```

Set `ALLOW_DEV_AUTH=true` to open the Mini App in a plain browser without
Telegram. It is refused in production.

---

## Layout

```
packages/
  shared/     money, game rules, progression, WS protocol  ← imported by all three
  backend/    Fastify API + WebSocket + authoritative game engine
  bot/        Telegram bot (grammY)
  frontend/   Mini App (React + Vite)
database/migrations/   versioned SQL
docker/                Dockerfiles + nginx
docs/                  architecture, schema, API, WS, security, deployment
```

`@cb/shared` matters more than its size suggests: the commission calculation,
the round-resolution rules and the level curve live there and are imported by
the server (authoritative), the client (preview) and the tests. They cannot
drift apart.

---

## The design decisions worth knowing

**The server decides everything.** Identity, balance, entry, commission, prize,
round winner, champion, XP. The client is a renderer. See
[`docs/07-anticheat.md`](docs/07-anticheat.md).

**GO is never announced.** The client is not told when the button goes live —
the countdown ends on an unpredictable jitter and `ROUND_START` is sent *at* the
instant. There is no future timestamp for a modified client to pre-fire against.
This is the single most important property of the timing design.

**A click carries no data.** No timestamp, no reaction time. The server stamps
arrival with its own monotonic clock, as the first statement after the frame is
read off the socket.

**Latency is compensated, but bounded.** RTT is measured server-side and taken
as the *minimum* of recent samples — a client can only make its latency look
worse, and one honest round trip pulls the minimum back down. The compensation
is capped. The residual exposure is documented rather than hidden.

**Money is `bigint` micro-USDT.** No float ever touches a balance. Non-negative
balances are a database CHECK, not an application `if`. Every ledger write is
idempotent, and the row is inserted *before* the balance moves so a retry is a
no-op rather than a second payout.

**AI never plays for your money by default.** `ai.paid_policy` is `DISABLED`:
no human opponent means a full refund, not a quiet match against the house.

---

## Tests

```bash
npm test         # shared + backend
npm run typecheck
```

56 tests currently pass without any infrastructure — the money math (including
the four spec tiers and value conservation), the round and match rules, the
level curve, initData verification including forgery and replay, and the AI
distribution and paid-mode policy.

An additional 11 ledger integration tests need Postgres, and skip without it:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://clickbattle:clickbattle@localhost:5432/clickbattle npm test
```

Run these before deploying. They are what prove money cannot be created or
destroyed.

---

## Configuration

`.env` holds secrets and infrastructure. **Everything else is a runtime setting
in the admin panel** — tiers, commission, round timing, the GO jitter window,
XP rewards, the level curve, AI behaviour, the membership gate, wallet limits,
maintenance mode. Changes apply in seconds with no restart, and every one is
written to the audit log.

Never commit `.env`. No private key, seed phrase or mnemonic appears anywhere in
this repository, and automated payouts are off by default.

---

## Documentation

| | |
|---|---|
| [01-architecture](docs/01-architecture.md) | system design, stack rationale, failure posture |
| [02-database](docs/02-database.md) | schema and why each constraint is there |
| [03-api](docs/03-api.md) | REST reference |
| [04-websocket](docs/04-websocket.md) | realtime protocol and round timeline |
| [05-auth](docs/05-auth.md) | Telegram initData verification, sessions |
| [06-wallet](docs/06-wallet.md) | ledger, idempotency, TON provider |
| [07-anticheat](docs/07-anticheat.md) | the timing model — **read this one** |
| [08-game-engine](docs/08-game-engine.md) | round state machine, AI, recovery |
| [09-admin](docs/09-admin.md) | admin surface and audit |
| [10-deployment](docs/10-deployment.md) | Docker, TLS, BotFather, scaling |
| [11-roadmap](docs/11-roadmap.md) | what is done, what is next |
