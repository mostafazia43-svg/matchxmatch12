-- Click Battle :: spendable in-game coins.
-- Coins are separate from ranking points: points decide the leaderboard,
-- coins are a balance a player can later spend (titles, cosmetics, ...).
-- A new migration, not an edit of 0001, so applied checksums stay valid.

BEGIN;

ALTER TABLE player_progress
  ADD COLUMN IF NOT EXISTS coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0);

COMMIT;
