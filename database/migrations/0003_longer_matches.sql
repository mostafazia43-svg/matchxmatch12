-- Click Battle :: longer matches (first to 3 round wins, up to 5 rounds).
-- Done as a new migration instead of editing 0001/0002, because the migration
-- runner checksums applied files and refuses to boot if they change.
-- Both values stay editable at runtime from the Admin panel.

BEGIN;

INSERT INTO app_settings (key, value) VALUES
  ('game.rounds_to_win', '3'),
  ('game.max_rounds',    '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
