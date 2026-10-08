# Database schema

PostgreSQL 16. Source of truth: `database/migrations/0001_init.sql`.

## Conventions

- **Money is `BIGINT` micro-USDT.** Never `NUMERIC`, never `FLOAT`. 1 USDT =
  1,000,000. `pg` returns BIGINT as a string, which is converted to `bigint`
  explicitly at the module boundary — letting it become a JS number would
  silently corrupt any balance above 2^53 micros.
- UUID primary keys (`gen_random_uuid()`), except `game_events` which is a
  `BIGSERIAL` because it is append-only and ordered.
- Status columns are `TEXT` + `CHECK`, not enums — adding a state later is a
  one-line migration instead of a type alteration.
- `TIMESTAMPTZ` everywhere; containers run `TZ=UTC`.

## Tables

### Identity

**`users`** — one row per Telegram account. `telegram_id BIGINT UNIQUE` is the
natural key. Carries the block flag and reason.

**`telegram_accounts`** — 1:1 with `users`. The raw Telegram profile snapshot,
auth counter, private `chat_id` for bot notifications, and cached channel
membership.

**`sessions`** — `jti UNIQUE`, expiry, `revoked_at`. Checked on every
authenticated request, which is what makes server-side revocation real.

### Money

**`wallets`** — 1:1 with `users`.

```sql
available_micros BIGINT NOT NULL DEFAULT 0 CHECK (available_micros >= 0)
locked_micros    BIGINT NOT NULL DEFAULT 0 CHECK (locked_micros    >= 0)
```

Those two CHECKs are the last line of defence against a bug creating USDT.

**`wallet_transactions`** — the append-only ledger.

```sql
idempotency_key TEXT NOT NULL UNIQUE   -- the guard against double-crediting
amount_micros   BIGINT NOT NULL        -- signed; CHECK (amount_micros <> 0)
affects_balance BOOLEAN NOT NULL DEFAULT TRUE
```

`affects_balance = FALSE` marks bookkeeping-only rows. A `COMMISSION` row
explains where part of a `MATCH_ENTRY` went; debiting for both would charge the
player twice.

Indexes: `(user_id, created_at DESC)` for statements,
`(reference_type, reference_id)` for match/deposit lookups, `(type, status)` for
revenue reporting.

**`deposits`** — `chain_tx_hash TEXT UNIQUE` is a chain-level guard against
double-credit, independent of the ledger's idempotency key.
Status: `PENDING` → `CONFIRMED` → `CREDITED`, or `ORPHANED` when the memo does
not identify a user.

**`withdrawals`** — `PENDING` → `APPROVED` → `SENDING` → `SENT`, or `REJECTED`
(which writes a `refund_tx_id`). `idempotency_key UNIQUE` stops a double-tap
creating two requests.

### Game

**`matches`** — mode, entry, commission bps and total, prize, status, format,
champion, `settled` flag, cancel reason.

```sql
CHECK (mode <> 'PAID' OR entry_micros > 0)
```

`settled BOOLEAN` is the outer idempotency guard for settlement; the ledger keys
are the inner one.

**`match_players`** — PK `(match_id, slot)`, slot ∈ {1,2}. `user_id` is NULL for
an AI opponent, guarded by `CHECK (is_ai OR user_id IS NOT NULL)`. A partial
unique index on `(match_id, user_id) WHERE user_id IS NOT NULL` stops a player
occupying both slots. Holds `entry_tx_id` / `prize_tx_id` / `refund_tx_id`, so
every player row points at the money that moved for it.

**`rounds`** — `UNIQUE (match_id, round_no)`. Stores the authoritative `go_at`,
the deadline, both reaction times, both false-start flags, the winner and the
reason. This is the record a disputed round is answered from.

**`game_events`** — append-only server event log: match created, round
transitions, early clicks, impossible reactions, settlement. Enough to
reconstruct any match.

### Progression

**`player_progress`** — level, XP, points, per-mode counters, best reaction,
streaks. Demo matches are deliberately excluded from every counter.

**`leaderboard`** — a **VIEW**, not a table:

```sql
RANK() OVER (ORDER BY points DESC, xp DESC, wins DESC, created_at ASC)
```

A view so the ranking formula can change without a data migration, and blocked
users are filtered out at the source rather than at every call site.

### Operations

**`app_settings`** — `key TEXT PK`, `value JSONB`. Everything an operator might
tune, editable at runtime.

**`admin_actions`** — the audit trail. Written before any privileged action
returns.

**`suspicious_events`** — anti-cheat flags with severity and a resolved flag.

**`notifications`** — outbound queue drained by the bot. Decoupling it this way
means a Telegram outage delays messages instead of failing a match settlement.

## Migrations

`packages/backend/src/db/migrate.ts` applies every `.sql` file in filename
order, exactly once, under `pg_advisory_lock` so two booting instances cannot
race. Each file is checksummed: editing an already-applied migration is an
error, not a silent divergence between environments.

```bash
npm run migrate            # standalone
                           # (also runs automatically at backend boot)
```
