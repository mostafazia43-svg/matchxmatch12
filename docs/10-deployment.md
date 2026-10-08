# Deployment

## Services

| Service | Image / build | Port | Purpose |
|---|---|---|---|
| `postgres` | postgres:16-alpine | 5432 | ledger, matches, settings |
| `redis` | redis:7-alpine | 6379 | rate limits (optional in dev) |
| `backend` | `docker/backend.Dockerfile` | 8080 | API + WebSocket + game engine |
| `bot` | `docker/bot.Dockerfile` | — | Telegram bot |
| `frontend` | `docker/frontend.Dockerfile` | 80 | Mini App behind nginx |

## First deploy

```bash
cp .env.example .env
# fill in BOT_TOKEN, JWT_SECRET, ADMIN_TELEGRAM_IDS, MINI_APP_URL,
# PLATFORM_WALLET_ADDRESS, TONAPI_KEY

openssl rand -hex 48        # -> JWT_SECRET

docker compose up -d --build
docker compose logs -f backend
```

Migrations run automatically at boot, under an advisory lock, so two instances
starting together cannot race.

## Production configuration checklist

The backend **refuses to start** if any of these are wrong
(`assertProductionSafety()` in `config/env.ts`):

- [ ] `NODE_ENV=production`
- [ ] `BOT_TOKEN` set — without it Telegram auth cannot be verified at all
- [ ] `JWT_SECRET` at least 32 chars and not the template placeholder
- [ ] `ALLOW_DEV_AUTH=false` — it is a complete auth bypass
- [ ] `ADMIN_TELEGRAM_IDS` non-empty
- [ ] `PLATFORM_WALLET_ADDRESS` set
- [ ] `MINI_APP_URL` starts with `https://`

Additionally, `tonProvider()` throws on `TON_PROVIDER=mock` in production — a
mock provider cannot verify real deposits.

## TLS

Telegram requires HTTPS for a Mini App. Terminate TLS at a reverse proxy in
front of `frontend`:

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.example;

  ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_buffering off;     # never delay the GO frame
  }
}
```

Two things that break the game if you get them wrong:

- **WebSocket upgrade headers must be forwarded** — without them the game
  silently falls back to nothing and no match can start.
- **`proxy_buffering off`** on the WS path — buffering delays the GO frame,
  which is the one frame in the system that must not be delayed.

## BotFather setup

1. `/newbot` → get `BOT_TOKEN`
2. `/setmenubutton` → point it at `MINI_APP_URL`
3. `/newapp` → register the Mini App with the same URL
4. `/setcommands`:

```
start - Open Click Battle
play - Play a match
balance - Check your USDT balance
stats - Your level, rank and record
leaderboard - Top players
help - How to play
```

## Scaling

The game engine holds live matches in **one process's memory**, so today the
backend is single-instance. Run one backend container and scale vertically; a
reaction game is latency-bound rather than CPU-bound, so this goes a long way.

To scale out later, matches need to be pinned to an instance (a Redis ownership
key per match id, with the gateway routing a player's socket to the owner). The
hub/engine split already isolates the change to `realtime/`.

`postgres` and `redis` scale normally.

## Backups

The ledger is the asset. Everything else can be rebuilt.

```bash
docker compose exec postgres pg_dump -U clickbattle clickbattle | gzip > backup.sql.gz
```

Automate it, store it off-host, and test a restore before you need one.

## Monitoring

- `GET /health` — returns **503 when the database is down**, deliberately, so a
  load balancer stops sending traffic rather than letting gameplay advance state
  it cannot persist.
- `GET /ready` — readiness + maintenance flag.
- Logs are structured JSON in production. Bot tokens, initData, JWTs and
  mnemonics are redacted at the logger — a leaked `BOT_TOKEN` in a log
  aggregator is a full account compromise.

Watch: open `suspicious_events`, pending withdrawals, `ORPHANED` deposits, and
`SUM(locked_micros)` — a locked total that never returns to zero means the
reconciliation sweep needs investigating.

## Operational notes

- Deposits are credited by a poller (`DEPOSIT_POLL_INTERVAL_MS`, 20s default).
- Withdrawals are **manual by default**: approve in the panel, send from the
  platform wallet, then Mark sent with the hash.
- Maintenance mode (`ops.maintenance_mode`) blocks new matches but lets existing
  ones finish. Admins are exempt.
- Restarting the backend cancels and refunds every live match. Prefer to restart
  during a quiet period.

## Before taking real money

This is a real-money product. Beyond the technical checklist, get legal advice
on licensing in your target jurisdictions, KYC/AML obligations, geo-restriction
of the paid mode, and responsible-play controls. The software does not decide
whether you are allowed to operate it.
