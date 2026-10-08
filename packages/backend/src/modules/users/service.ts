/**
 * Player profile and progression read model.
 * Also owns the optional Telegram membership gate.
 */

import { levelFromXp, type PlayerProgress } from '@cb/shared';
import { getSettings, levelCurve } from '../../config/settings.js';
import { env } from '../../config/env.js';
import { queryOne } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export async function progressFor(userId: string): Promise<PlayerProgress> {
  const settings = await getSettings();
  const row = await queryOne<{
    level: number;
    xp: string;
    points: string;
    total_matches: number;
    wins: number;
    losses: number;
    free_matches: number;
    free_wins: number;
    paid_matches: number;
    paid_wins: number;
    best_reaction_ms: number | null;
    current_streak: number;
    best_streak: number;
  }>(
    `SELECT level, xp, points, total_matches, wins, losses, free_matches, free_wins,
            paid_matches, paid_wins, best_reaction_ms, current_streak, best_streak
       FROM player_progress WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw errors.notFound('Progress not found.');

  const state = levelFromXp(BigInt(row.xp), levelCurve(settings));

  return {
    level: state.level,
    xp: row.xp,
    xpIntoLevel: state.xpIntoLevel.toString(),
    xpForNextLevel: state.xpForNextLevel.toString(),
    points: row.points,
    totalMatches: row.total_matches,
    wins: row.wins,
    losses: row.losses,
    winRate: row.total_matches > 0 ? Math.round((row.wins / row.total_matches) * 1000) / 10 : 0,
    freeMatches: row.free_matches,
    freeWins: row.free_wins,
    paidMatches: row.paid_matches,
    paidWins: row.paid_wins,
    bestReactionMs: row.best_reaction_ms,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
  };
}

export async function myRank(userId: string): Promise<number | null> {
  const row = await queryOne<{ rank: string }>('SELECT rank FROM leaderboard WHERE user_id = $1', [
    userId,
  ]);
  return row ? Number(row.rank) : null;
}

// ---------------------------------------------------------------- membership gate

interface MembershipCache {
  isMember: boolean;
  checkedAt: number;
}
const membershipCache = new Map<string, MembershipCache>();
const MEMBERSHIP_TTL_MS = 5 * 60_000;

/**
 * Verify Telegram channel/group membership when the admin has enabled the gate.
 *
 * Deliberate failure posture: if the Telegram API is unreachable we let the
 * player through. Locking everyone out of the game because a third-party API
 * blipped is a worse outcome than briefly admitting someone who has not joined.
 */
export async function checkMembership(
  telegramId: bigint,
  userId: string,
): Promise<{ required: boolean; isMember: boolean; inviteUrl: string }> {
  const settings = await getSettings();
  const inviteUrl = settings['membership.invite_url'];

  if (!settings['membership.enabled'] || !settings['membership.chat']) {
    return { required: false, isMember: true, inviteUrl };
  }
  if (!env.BOT_TOKEN) {
    logger.warn('membership gate is enabled but BOT_TOKEN is not set; allowing access');
    return { required: false, isMember: true, inviteUrl };
  }

  const cached = membershipCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < MEMBERSHIP_TTL_MS) {
    return { required: true, isMember: cached.isMember, inviteUrl };
  }

  try {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings['membership.chat'], user_id: Number(telegramId) }),
      signal: AbortSignal.timeout(8_000),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { status?: string };
    };

    const status = payload.result?.status ?? '';
    const isMember = ['creator', 'administrator', 'member'].includes(status);

    membershipCache.set(userId, { isMember, checkedAt: Date.now() });
    await queryOne(
      `UPDATE telegram_accounts
          SET is_channel_member = $2, membership_checked_at = now()
        WHERE user_id = $1`,
      [userId, isMember],
    ).catch(() => undefined);

    return { required: true, isMember, inviteUrl };
  } catch (error) {
    logger.warn({ err: error }, 'membership check failed; allowing access');
    return { required: true, isMember: true, inviteUrl };
  }
}

/** Throws if the gate applies to `mode` and the player has not joined. */
export async function assertMembershipFor(
  telegramId: bigint,
  userId: string,
  mode: string,
): Promise<void> {
  const settings = await getSettings();
  if (!settings['membership.enabled']) return;
  if (!settings['membership.required_for'].includes(mode as 'FREE' | 'PAID' | 'DEMO')) return;

  const result = await checkMembership(telegramId, userId);
  if (result.required && !result.isMember) {
    throw errors.membershipRequired(result.inviteUrl);
  }
}

export function clearMembershipCache(userId?: string): void {
  if (userId) membershipCache.delete(userId);
  else membershipCache.clear();
}
