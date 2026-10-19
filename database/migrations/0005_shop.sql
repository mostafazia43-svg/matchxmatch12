-- Click Battle :: coin shop.
-- One row per (player, item): the UNIQUE constraint is what makes buying the
-- same item twice impossible, even with two simultaneous requests.

BEGIN;

CREATE TABLE IF NOT EXISTS shop_purchases (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT        NOT NULL,
  price_coins BIGINT      NOT NULL CHECK (price_coins >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS shop_purchases_user_idx ON shop_purchases (user_id);

ALTER TABLE player_progress
  ADD COLUMN IF NOT EXISTS equipped_title TEXT,
  ADD COLUMN IF NOT EXISTS equipped_theme TEXT;

COMMIT;
