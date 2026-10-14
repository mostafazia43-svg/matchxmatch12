/**
 * Runtime settings.
 *
 * Everything an operator might want to tune — tiers, commission, XP rewards,
 * matchmaking timeout, AI behaviour, the membership gate — lives in the
 * `app_settings` table rather than in code, so the admin panel can change it
 * without a deploy. Values are cached briefly and invalidated on write.
 */

import { z } from 'zod';
import type { GameMode, PaidAiPolicy, PublicConfig } from '@cb/shared';
import { query, queryOne, type Tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { env } from './env.js';

const CACHE_TTL_MS = 5_000;

const schema = z.object({
  'game.free_enabled': z.boolean(),
  'game.paid_enabled': z.boolean(),
  'game.demo_enabled': z.boolean(),
  'game.paid_tiers_micros': z.array(z.union([z.number(), z.string()])),
  'game.commission_bps': z.number().int().min(0).max(10_000),
  'game.rounds_to_win': z.number().int().min(1).max(10),
  'game.max_rounds': z.number().int().min(1).max(21),
  'game.countdown_ms': z.number().int().min(500).max(10_000),
  'game.round_timeout_ms': z.number().int().min(1_000).max(30_000),
  'game.go_jitter_min_ms': z.number().int().min(0).max(10_000),
  'game.go_jitter_max_ms': z.number().int().min(0).max(15_000),
  'game.inter_round_ms': z.number().int().min(500).max(15_000),
  'game.min_human_reaction_ms': z.number().int().min(80).max(500),
  'game.max_rtt_compensation_ms': z.number().int().min(0).max(1_000),
  'game.disconnect_grace_ms': z.number().int().min(0).max(120_000),

  'matchmaking.timeout_ms': z.number().int().min(3_000).max(300_000),
  'matchmaking.max_queue_wait_ms': z.number().int().min(5_000).max(600_000),

  'ai.enabled': z.boolean(),
  'ai.reaction_mean_ms': z.number().min(100).max(2_000),
  'ai.reaction_stddev_ms': z.number().min(1).max(500),
  'ai.reaction_min_ms': z.number().min(100).max(2_000),
  'ai.reaction_max_ms': z.number().min(100).max(5_000),
  'ai.false_start_chance': z.number().min(0).max(0.5),
  'ai.miss_chance': z.number().min(0).max(0.5),
  'ai.paid_policy': z.enum(['DISABLED', 'REFUND_AND_OFFER', 'HOUSE_STAKE_DISCLOSED']),

  'xp.free_win': z.number().int().min(0),
  'xp.free_loss': z.number().int().min(0),
  'xp.paid_win': z.number().int().min(0),
  'xp.paid_loss': z.number().int().min(0),
  'xp.round_win': z.number().int().min(0),
  'xp.demo_win': z.number().int().min(0),
  'xp.demo_loss': z.number().int().min(0),
  'points.free_win': z.number().int().min(0),
  'points.free_loss': z.number().int().min(0),
  'points.paid_win': z.number().int().min(0),
  'points.paid_loss': z.number().int().min(0),
  'points.streak_bonus': z.number().int().min(0),
  'level.curve_base': z.number().min(1),
  'level.curve_exponent': z.number().min(1).max(3),
  'level.max': z.number().int().min(10).max(1_000),

  'membership.enabled': z.boolean(),
  'membership.chat': z.string(),
  'membership.invite_url': z.string(),
  'membership.required_for': z.array(z.enum(['FREE', 'PAID', 'DEMO'])),

  'wallet.deposits_enabled': z.boolean(),
  'wallet.withdrawals_enabled': z.boolean(),
  'wallet.min_deposit_micros': z.union([z.number(), z.string()]),
  'wallet.min_withdrawal_micros': z.union([z.number(), z.string()]),
  'wallet.withdrawal_fee_micros': z.union([z.number(), z.string()]),
  'wallet.auto_approve_under_micros': z.union([z.number(), z.string()]),
  'wallet.required_confirmations': z.number().int().min(0).max(50),

  'ops.maintenance_mode': z.boolean(),
  'ops.maintenance_message': z.string(),
});

export type SettingKey = keyof z.infer<typeof schema>;
export type SettingsMap = z.infer<typeof schema>;

/** Boot defaults, mirroring 0002_seed_settings.sql so the app runs before seeding. */
const DEFAULTS: SettingsMap = {
  'game.free_enabled': true,
  'game.paid_enabled': true,
  'game.demo_enabled': true,
  'game.paid_tiers_micros': [5_000_000, 10_000_000, 30_000_000, 50_000_000],
  'game.commission_bps': 500,
  'game.rounds_to_win': 3,
  'game.max_rounds': 5,
  'game.countdown_ms': 3_000,
  'game.round_timeout_ms': 5_000,
  'game.go_jitter_min_ms': 300,
  'game.go_jitter_max_ms': 2_000,
  'game.inter_round_ms': 2_500,
  'game.min_human_reaction_ms': 90,
  'game.max_rtt_compensation_ms': 250,
  'game.disconnect_grace_ms': 15_000,
  'matchmaking.timeout_ms': 15_000,
  'matchmaking.max_queue_wait_ms': 120_000,
  'ai.enabled': true,
  'ai.reaction_mean_ms': 265,
  'ai.reaction_stddev_ms': 55,
  'ai.reaction_min_ms': 170,
  'ai.reaction_max_ms': 520,
  'ai.false_start_chance': 0.02,
  'ai.miss_chance': 0.01,
  'ai.paid_policy': 'DISABLED',
  'xp.free_win': 25,
  'xp.free_loss': 8,
  'xp.paid_win': 90,
  'xp.paid_loss': 30,
  'xp.round_win': 5,
  'xp.demo_win': 0,
  'xp.demo_loss': 0,
  'points.free_win': 10,
  'points.free_loss': 0,
  'points.paid_win': 40,
  'points.paid_loss': 2,
  'points.streak_bonus': 5,
  'level.curve_base': 120,
  'level.curve_exponent': 1.45,
  'level.max': 200,
  'membership.enabled': false,
  'membership.chat': '',
  'membership.invite_url': '',
  'membership.required_for': ['PAID'],
  'wallet.deposits_enabled': true,
  'wallet.withdrawals_enabled': true,
  'wallet.min_deposit_micros': 1_000_000,
  'wallet.min_withdrawal_micros': 5_000_000,
  'wallet.withdrawal_fee_micros': 300_000,
  'wallet.auto_approve_under_micros': 0,
  'wallet.required_confirmations': 1,
  'ops.maintenance_mode': false,
  'ops.maintenance_message': 'Click Battle is under maintenance. Back shortly.',
};

let cache: SettingsMap = { ...DEFAULTS };
let cachedAt = 0;
let inFlight: Promise<SettingsMap> | null = null;

async function load(): Promise<SettingsMap> {
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
  const merged: Record<string, unknown> = { ...DEFAULTS };
  for (const row of rows) {
    if (row.key in DEFAULTS) merged[row.key] = row.value;
  }

  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    // A bad row must not take the game down — fall back to the default for it.
    logger.warn({ issues: parsed.error.issues }, 'invalid settings row(s); using defaults for those keys');
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as string;
      if (key in DEFAULTS) merged[key] = DEFAULTS[key as SettingKey];
    }
    return schema.parse(merged);
  }
  return parsed.data;
}

/** Cached settings snapshot. Safe to call on every request. */
export async function getSettings(): Promise<SettingsMap> {
  if (Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = load()
    .then((loaded) => {
      cache = loaded;
      cachedAt = Date.now();
      return loaded;
    })
    .catch((error) => {
      logger.error({ err: error }, 'failed to load settings; serving last known values');
      return cache;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Synchronous read of the last snapshot — for hot paths inside the game loop. */
export function settingsSnapshot(): SettingsMap {
  return cache;
}

export function invalidateSettings(): void {
  cachedAt = 0;
}

export async function setSetting(
  key: SettingKey,
  value: unknown,
  updatedBy: string | null,
  tx?: Tx,
): Promise<void> {
  const candidate = { ...cache, [key]: value };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path[0] === key);
    throw new Error(`Invalid value for ${key}: ${issue?.message ?? 'validation failed'}`);
  }

  const sql = `
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES ($1, $2::jsonb, $3, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
  const params = [key, JSON.stringify(value), updatedBy];
  if (tx) await tx.query(sql, params);
  else await queryOne(sql, params);

  invalidateSettings();
}

// ---------------------------------------------------------------- derived views

export function paidTiers(s: SettingsMap): bigint[] {
  return s['game.paid_tiers_micros'].map((v) => BigInt(v)).filter((v) => v > 0n);
}

export function isTierAllowed(s: SettingsMap, entryMicros: bigint): boolean {
  return paidTiers(s).some((tier) => tier === entryMicros);
}

export function modeEnabled(s: SettingsMap, mode: GameMode): boolean {
  if (mode === 'FREE') return s['game.free_enabled'];
  if (mode === 'PAID') return s['game.paid_enabled'];
  return s['game.demo_enabled'];
}

export function paidAiPolicy(s: SettingsMap): PaidAiPolicy {
  return s['ai.paid_policy'];
}

export function xpTable(s: SettingsMap) {
  return {
    freeWin: s['xp.free_win'],
    freeLoss: s['xp.free_loss'],
    paidWin: s['xp.paid_win'],
    paidLoss: s['xp.paid_loss'],
    demoWin: s['xp.demo_win'],
    demoLoss: s['xp.demo_loss'],
    roundWin: s['xp.round_win'],
  };
}

export function pointsTable(s: SettingsMap) {
  return {
    freeWin: s['points.free_win'],
    freeLoss: s['points.free_loss'],
    paidWin: s['points.paid_win'],
    paidLoss: s['points.paid_loss'],
    streakBonus: s['points.streak_bonus'],
  };
}

export function levelCurve(s: SettingsMap) {
  return {
    base: s['level.curve_base'],
    exponent: s['level.curve_exponent'],
    max: s['level.max'],
  };
}

/**
 * The ONLY settings the Mini App receives.
 * Nothing secret, nothing that would let a client infer another player's state.
 */
export function publicConfig(s: SettingsMap, chatTitle = ''): PublicConfig {
  return {
    modes: {
      free: s['game.free_enabled'],
      paid: s['game.paid_enabled'],
      demo: s['game.demo_enabled'],
    },
    paidTiersMicros: paidTiers(s).map(String),
    commissionBps: s['game.commission_bps'],
    roundsToWin: s['game.rounds_to_win'],
    maxRounds: s['game.max_rounds'],
    countdownMs: s['game.countdown_ms'],
    roundTimeoutMs: s['game.round_timeout_ms'],
    matchmakingTimeoutMs: s['matchmaking.timeout_ms'],
    paidAiPolicy: s['ai.paid_policy'],
    membership: {
      enabled: s['membership.enabled'],
      requiredFor: s['membership.required_for'] as GameMode[],
      inviteUrl: s['membership.invite_url'],
      chatTitle,
    },
    wallet: {
      depositsEnabled: s['wallet.deposits_enabled'],
      withdrawalsEnabled: s['wallet.withdrawals_enabled'],
      minDepositMicros: String(s['wallet.min_deposit_micros']),
      minWithdrawalMicros: String(s['wallet.min_withdrawal_micros']),
      withdrawalFeeMicros: String(s['wallet.withdrawal_fee_micros']),
      platformAddress: env.PLATFORM_WALLET_ADDRESS,
      network: env.TON_NETWORK,
    },
    maintenance: {
      enabled: s['ops.maintenance_mode'],
      message: s['ops.maintenance_message'],
    },
  };
}

export { DEFAULTS as SETTING_DEFAULTS, schema as settingsSchema };
