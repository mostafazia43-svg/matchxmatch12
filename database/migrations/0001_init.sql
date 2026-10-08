-- Click Battle :: initial schema
-- MONEY RULE: all amounts are BIGINT micro-USDT (1 USDT = 1_000_000). Never float.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users

CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT      NOT NULL UNIQUE,
  username        TEXT,
  first_name      TEXT        NOT NULL DEFAULT '',
  last_name       TEXT,
  photo_url       TEXT,
  language_code   TEXT,
  is_premium      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_blocked      BOOLEAN     NOT NULL DEFAULT FALSE,
  blocked_reason  TEXT,
  blocked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_last_seen_idx ON users (last_seen_at DESC);
CREATE INDEX users_username_idx  ON users (lower(username));

-- Telegram profile snapshot + auth audit (1:1 with users).
CREATE TABLE telegram_accounts (
  user_id               UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_id           BIGINT      NOT NULL UNIQUE,
  raw_profile           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  auth_count            INTEGER     NOT NULL DEFAULT 0,
  last_auth_at          TIMESTAMPTZ,
  chat_id               BIGINT,
  is_channel_member     BOOLEAN     NOT NULL DEFAULT FALSE,
  membership_checked_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti          TEXT        NOT NULL UNIQUE,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id, revoked_at);

-- ---------------------------------------------------------------- wallet

CREATE TABLE wallets (
  user_id                UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_micros       BIGINT      NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
  locked_micros          BIGINT      NOT NULL DEFAULT 0 CHECK (locked_micros    >= 0),
  ton_address            TEXT,
  total_deposited_micros BIGINT      NOT NULL DEFAULT 0 CHECK (total_deposited_micros >= 0),
  total_withdrawn_micros BIGINT      NOT NULL DEFAULT 0 CHECK (total_withdrawn_micros >= 0),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only ledger. Rows are never UPDATEd except PENDING -> terminal status.
CREATE TABLE wallet_transactions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type                 TEXT        NOT NULL CHECK (type IN (
                         'DEPOSIT','WITHDRAWAL','MATCH_ENTRY','COMMISSION',
                         'PRIZE','REFUND','ADMIN_ADJUSTMENT')),
  status               TEXT        NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FAILED','CANCELLED')),
  amount_micros        BIGINT      NOT NULL,
  currency             TEXT        NOT NULL DEFAULT 'USDT',
  -- FALSE for bookkeeping-only rows. A COMMISSION row explains where part of a
  -- MATCH_ENTRY went; debiting the balance for both would charge the player twice.
  affects_balance      BOOLEAN     NOT NULL DEFAULT TRUE,
  balance_after_micros BIGINT,
  idempotency_key      TEXT        NOT NULL UNIQUE,
  reference_type       TEXT,
  reference_id         TEXT,
  metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at           TIMESTAMPTZ,
  CHECK (amount_micros <> 0)
);
CREATE INDEX wtx_user_time_idx ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX wtx_ref_idx       ON wallet_transactions (reference_type, reference_id);
CREATE INDEX wtx_type_idx      ON wallet_transactions (type, status);

CREATE TABLE deposits (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  chain_tx_hash  TEXT        NOT NULL UNIQUE,
  from_address   TEXT,
  to_address     TEXT        NOT NULL,
  amount_micros  BIGINT      NOT NULL CHECK (amount_micros > 0),
  comment        TEXT,
  status         TEXT        NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING','CONFIRMED','CREDITED','ORPHANED','FAILED')),
  confirmations  INTEGER     NOT NULL DEFAULT 0,
  credited_tx_id UUID        REFERENCES wallet_transactions(id),
  raw            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  chain_time     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deposits_user_idx   ON deposits (user_id, created_at DESC);
CREATE INDEX deposits_status_idx ON deposits (status);

CREATE TABLE withdrawals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_address      TEXT        NOT NULL,
  amount_micros   BIGINT      NOT NULL CHECK (amount_micros > 0),
  fee_micros      BIGINT      NOT NULL DEFAULT 0 CHECK (fee_micros >= 0),
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING','APPROVED','REJECTED','SENDING','SENT','FAILED')),
  hold_tx_id      UUID        REFERENCES wallet_transactions(id),
  refund_tx_id    UUID        REFERENCES wallet_transactions(id),
  chain_tx_hash   TEXT,
  reviewed_by     UUID        REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  idempotency_key TEXT        NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_status_idx ON withdrawals (status, created_at);
CREATE INDEX withdrawals_user_idx   ON withdrawals (user_id, created_at DESC);

-- ---------------------------------------------------------------- game

CREATE TABLE matches (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code        TEXT        NOT NULL UNIQUE,
  mode              TEXT        NOT NULL CHECK (mode IN ('FREE','PAID','DEMO')),
  entry_micros      BIGINT      NOT NULL DEFAULT 0 CHECK (entry_micros >= 0),
  commission_bps    INTEGER     NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  commission_micros BIGINT      NOT NULL DEFAULT 0 CHECK (commission_micros >= 0),
  prize_micros      BIGINT      NOT NULL DEFAULT 0 CHECK (prize_micros >= 0),
  status            TEXT        NOT NULL DEFAULT 'COUNTDOWN' CHECK (status IN (
                       'MATCHED','COUNTDOWN','ROUND_ACTIVE','ROUND_FINISHED',
                       'MATCH_FINISHED','CANCELLED')),
  rounds_to_win     SMALLINT    NOT NULL DEFAULT 2 CHECK (rounds_to_win > 0),
  max_rounds        SMALLINT    NOT NULL DEFAULT 3 CHECK (max_rounds > 0),
  current_round     SMALLINT    NOT NULL DEFAULT 0,
  is_ai_match       BOOLEAN     NOT NULL DEFAULT FALSE,
  winner_user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  winner_slot       SMALLINT,
  settled           BOOLEAN     NOT NULL DEFAULT FALSE,
  cancel_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  CHECK (mode <> 'PAID' OR entry_micros > 0)
);
CREATE INDEX matches_status_idx ON matches (status, created_at DESC);
CREATE INDEX matches_mode_idx   ON matches (mode, created_at DESC);
CREATE INDEX matches_open_idx   ON matches (created_at)
  WHERE status NOT IN ('MATCH_FINISHED','CANCELLED');

CREATE TABLE match_players (
  match_id     UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  slot         SMALLINT    NOT NULL CHECK (slot IN (1,2)),
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  is_ai        BOOLEAN     NOT NULL DEFAULT FALSE,
  display_name TEXT        NOT NULL,
  avatar_url   TEXT,
  level        INTEGER     NOT NULL DEFAULT 1,
  rounds_won   SMALLINT    NOT NULL DEFAULT 0,
  entry_tx_id  UUID        REFERENCES wallet_transactions(id),
  prize_tx_id  UUID        REFERENCES wallet_transactions(id),
  refund_tx_id UUID        REFERENCES wallet_transactions(id),
  connection   TEXT        NOT NULL DEFAULT 'ONLINE'
                           CHECK (connection IN ('ONLINE','OFFLINE','FORFEIT')),
  avg_rtt_ms   INTEGER,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, slot),
  CHECK (is_ai OR user_id IS NOT NULL)
);
CREATE UNIQUE INDEX match_players_unique_user ON match_players (match_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX match_players_user_idx ON match_players (user_id, joined_at DESC);

CREATE TABLE rounds (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id       UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_no       SMALLINT    NOT NULL CHECK (round_no > 0),
  status         TEXT        NOT NULL DEFAULT 'COUNTDOWN'
                             CHECK (status IN ('COUNTDOWN','ACTIVE','FINISHED','VOID')),
  go_at          TIMESTAMPTZ NOT NULL,
  deadline_at    TIMESTAMPTZ NOT NULL,
  winner_slot    SMALLINT    CHECK (winner_slot IN (1,2)),
  win_reason     TEXT        CHECK (win_reason IN ('FASTEST','FALSE_START','TIMEOUT','FORFEIT','TIE')),
  p1_reaction_ms INTEGER,
  p2_reaction_ms INTEGER,
  p1_false_start BOOLEAN     NOT NULL DEFAULT FALSE,
  p2_false_start BOOLEAN     NOT NULL DEFAULT FALSE,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, round_no)
);

CREATE TABLE game_events (
  id          BIGSERIAL   PRIMARY KEY,
  match_id    UUID        REFERENCES matches(id) ON DELETE CASCADE,
  round_no    SMALLINT,
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT        NOT NULL,
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  server_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX game_events_match_idx ON game_events (match_id, id);
CREATE INDEX game_events_type_idx  ON game_events (type, server_time DESC);

-- ---------------------------------------------------------------- progression

CREATE TABLE player_progress (
  user_id             UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level               INTEGER     NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp                  BIGINT      NOT NULL DEFAULT 0 CHECK (xp >= 0),
  points              BIGINT      NOT NULL DEFAULT 0,
  total_matches       INTEGER     NOT NULL DEFAULT 0,
  wins                INTEGER     NOT NULL DEFAULT 0,
  losses              INTEGER     NOT NULL DEFAULT 0,
  free_matches        INTEGER     NOT NULL DEFAULT 0,
  free_wins           INTEGER     NOT NULL DEFAULT 0,
  paid_matches        INTEGER     NOT NULL DEFAULT 0,
  paid_wins           INTEGER     NOT NULL DEFAULT 0,
  paid_wagered_micros BIGINT      NOT NULL DEFAULT 0,
  paid_won_micros     BIGINT      NOT NULL DEFAULT 0,
  best_reaction_ms    INTEGER,
  current_streak      INTEGER     NOT NULL DEFAULT 0,
  best_streak         INTEGER     NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX progress_points_idx ON player_progress (points DESC, xp DESC, wins DESC);

-- Ranking is a view so the formula can change without a data migration.
CREATE VIEW leaderboard AS
SELECT
  u.id                                          AS user_id,
  u.telegram_id,
  COALESCE(NULLIF(u.username, ''), u.first_name) AS display_name,
  u.photo_url,
  p.level, p.xp, p.points, p.wins, p.losses, p.total_matches,
  CASE WHEN p.total_matches > 0
       THEN ROUND((p.wins::numeric / p.total_matches) * 100, 1)
       ELSE 0 END                               AS win_rate,
  p.best_reaction_ms,
  RANK() OVER (ORDER BY p.points DESC, p.xp DESC, p.wins DESC, u.created_at ASC) AS rank
FROM player_progress p
JOIN users u ON u.id = p.user_id
WHERE u.is_blocked = FALSE;

-- ---------------------------------------------------------------- ops

CREATE TABLE app_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by UUID        REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_actions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID        NOT NULL REFERENCES users(id),
  action        TEXT        NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_time_idx ON admin_actions (created_at DESC);

CREATE TABLE suspicious_events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES users(id) ON DELETE CASCADE,
  match_id   UUID        REFERENCES matches(id) ON DELETE SET NULL,
  kind       TEXT        NOT NULL,
  severity   SMALLINT    NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
  detail     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  resolved   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suspicious_open_idx ON suspicious_events (resolved, created_at DESC);

CREATE TABLE notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts   SMALLINT    NOT NULL DEFAULT 0,
  error      TEXT,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_pending_idx ON notifications (status, created_at)
  WHERE status = 'PENDING';

COMMIT;
