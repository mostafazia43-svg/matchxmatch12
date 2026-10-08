-- Click Battle :: default runtime settings.
-- Every value here is editable from the Admin panel at runtime; this file only
-- establishes the boot defaults. Amounts are micro-USDT.

BEGIN;

INSERT INTO app_settings (key, value) VALUES
  -- ---- game modes
  ('game.free_enabled',            'true'),
  ('game.paid_enabled',            'true'),
  ('game.demo_enabled',            'true'),

  -- ---- paid tiers: $5 / $10 / $30 / $50
  ('game.paid_tiers_micros',       '[5000000, 10000000, 30000000, 50000000]'),
  ('game.commission_bps',          '500'),

  -- ---- match format
  ('game.rounds_to_win',           '2'),
  ('game.max_rounds',              '3'),
  ('game.countdown_ms',            '3000'),
  ('game.round_timeout_ms',        '5000'),
  -- GO fires at a random point in this window AFTER the visible countdown, so
  -- there is no announced instant a modified client could pre-fire against.
  ('game.go_jitter_min_ms',        '300'),
  ('game.go_jitter_max_ms',        '2000'),
  ('game.inter_round_ms',          '2500'),
  ('game.min_human_reaction_ms',   '90'),
  ('game.max_rtt_compensation_ms', '250'),
  ('game.disconnect_grace_ms',     '15000'),

  -- ---- matchmaking
  ('matchmaking.timeout_ms',       '15000'),
  ('matchmaking.max_queue_wait_ms','120000'),

  -- ---- AI opponent
  ('ai.enabled',                   'true'),
  ('ai.reaction_mean_ms',          '265'),
  ('ai.reaction_stddev_ms',        '55'),
  ('ai.reaction_min_ms',           '170'),
  ('ai.reaction_max_ms',           '520'),
  ('ai.false_start_chance',        '0.02'),
  ('ai.miss_chance',               '0.01'),
  -- DISABLED            : no AI in paid mode; player is refunded and offered Free/Demo (default, fairest)
  -- REFUND_AND_OFFER    : same as DISABLED but keeps the player in a free rematch flow
  -- HOUSE_STAKE_DISCLOSED: house stakes the opposing side; UI must label the opponent as house AI
  ('ai.paid_policy',               '"DISABLED"'),

  -- ---- progression (all configurable from admin)
  ('xp.free_win',                  '25'),
  ('xp.free_loss',                 '8'),
  ('xp.paid_win',                  '90'),
  ('xp.paid_loss',                 '30'),
  ('xp.round_win',                 '5'),
  ('xp.demo_win',                  '0'),
  ('xp.demo_loss',                 '0'),
  ('points.free_win',              '10'),
  ('points.free_loss',             '0'),
  ('points.paid_win',              '40'),
  ('points.paid_loss',             '2'),
  ('points.streak_bonus',          '5'),
  -- level N requires base * N^exponent XP (scalable: no hard-coded level table)
  ('level.curve_base',             '120'),
  ('level.curve_exponent',         '1.45'),
  ('level.max',                    '200'),

  -- ---- telegram membership gate
  ('membership.enabled',           'false'),
  ('membership.chat',              '""'),
  ('membership.invite_url',        '""'),
  ('membership.required_for',      '["PAID"]'),

  -- ---- wallet
  ('wallet.deposits_enabled',      'true'),
  ('wallet.withdrawals_enabled',   'true'),
  ('wallet.min_deposit_micros',    '1000000'),
  ('wallet.min_withdrawal_micros', '5000000'),
  ('wallet.withdrawal_fee_micros', '300000'),
  ('wallet.auto_approve_under_micros', '0'),
  ('wallet.required_confirmations','1'),

  -- ---- ops
  ('ops.maintenance_mode',         'false'),
  ('ops.maintenance_message',      '"Click Battle is under maintenance. Back shortly."')
ON CONFLICT (key) DO NOTHING;

COMMIT;
