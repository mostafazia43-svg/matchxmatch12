/**
 * Match settlement — the only place a prize is paid or an entry is refunded.
 *
 * The whole file runs inside one database transaction per call and every
 * ledger write is keyed on the match id, so re-running settlement (a retry, a
 * crash-recovery sweep, a duplicate WS event) is a no-op rather than a second
 * payout. `matches.settled` is the outer guard; ledger idempotency keys are
 * the inner one.
 *
 * The order matters: the champion must already be decided before this is
 * called. Nothing here can determine a winner.
 */

import {
  computeMatchEconomics,
  computeRewards,
  levelFromXp,
  type GameMode,
  type PlayerSlot,
} from '@cb/shared';
import {
  getSettings,
  levelCurve,
  pointsTable,
  xpTable,
  type SettingsMap,
} from '../../config/settings.js';
import { toBigInt, withTransaction, type Tx } from '../../db/pool.js';
import { ledgerKey } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import * as ledger from '../wallet/ledger.js';
import { recordEvent } from './store.js';

export interface SettlementPlayer {
  slot: PlayerSlot;
  userId: string | null;
  isAi: boolean;
  roundsWon: number;
}

export interface SettlementInput {
  matchId: string;
  mode: GameMode;
  entryMicros: bigint;
  commissionBps: number;
  championSlot: PlayerSlot;
  players: SettlementPlayer[];
}

export interface PlayerSettlement {
  slot: PlayerSlot;
  userId: string;
  won: boolean;
  prizeMicros: bigint;
  xpGained: bigint;
  pointsGained: bigint;
  newLevel: number;
  levelUp: number | null;
  availableMicros: bigint;
  lockedMicros: bigint;
}

/**
 * Charge both entries.
 *
 * Called when the match actually starts, not when the player queued: money
 * only becomes spent once there is a real opponent and a real match. Until
 * then it is merely locked (see `ledger.lockFunds`).
 *
 * Writes two rows per player:
 *   MATCH_ENTRY  -entry      (moves the balance)
 *   COMMISSION   -commission (bookkeeping only; explains where part of the
 *                             entry went without charging the player twice)
 */
export async function chargeEntries(tx: Tx, input: {
  matchId: string;
  entryMicros: bigint;
  commissionBps: number;
  players: { slot: PlayerSlot; userId: string | null; isAi: boolean }[];
}): Promise<void> {
  if (input.entryMicros <= 0n) return;
  const econ = computeMatchEconomics(input.entryMicros, input.commissionBps);

  for (const player of input.players) {
    if (player.isAi || !player.userId) continue;

    const entry = await ledger.consumeLock(tx, {
      userId: player.userId,
      type: 'MATCH_ENTRY',
      amountMicros: econ.entryMicros,
      idempotencyKey: ledgerKey('match', input.matchId, 'entry', player.userId),
      referenceType: 'match',
      referenceId: input.matchId,
      metadata: {
        slot: player.slot,
        commissionMicros: econ.commissionPerPlayerMicros.toString(),
        prizePoolMicros: econ.prizeMicros.toString(),
      },
    });

    if (!entry.duplicate && econ.commissionPerPlayerMicros > 0n) {
      await ledger.record(tx, {
        userId: player.userId,
        type: 'COMMISSION',
        amountMicros: -econ.commissionPerPlayerMicros,
        idempotencyKey: ledgerKey('match', input.matchId, 'commission', player.userId),
        referenceType: 'match',
        referenceId: input.matchId,
        affectsBalance: false,
        metadata: {
          note: 'Platform fee included in your entry',
          commissionBps: input.commissionBps,
          entryMicros: econ.entryMicros.toString(),
        },
      });
    }

    await tx.query('UPDATE match_players SET entry_tx_id = $3 WHERE match_id = $1 AND slot = $2', [
      input.matchId,
      player.slot,
      entry.transactionId || null,
    ]);
  }
}

/**
 * Pay the champion and update both players' progression.
 * Returns per-player results so the gateway can tell each client what changed.
 */
export async function settleMatch(input: SettlementInput): Promise<PlayerSettlement[]> {
  const settings = await getSettings();

  return withTransaction(async (tx) => {
    // Claim the match. If another path already settled it, do nothing.
    const claim = await tx.query<{ id: string }>(
      `UPDATE matches
          SET settled = TRUE, status = 'MATCH_FINISHED', finished_at = now(),
              winner_slot = $2,
              winner_user_id = (SELECT user_id FROM match_players WHERE match_id = $1 AND slot = $2)
        WHERE id = $1 AND settled = FALSE
        RETURNING id`,
      [input.matchId, input.championSlot],
    );
    if (claim.rowCount === 0) {
      logger.debug({ matchId: input.matchId }, 'match already settled; skipping');
      return [];
    }

    const econ = computeMatchEconomics(input.entryMicros, input.commissionBps);
    const results: PlayerSettlement[] = [];

    for (const player of input.players) {
      if (player.isAi || !player.userId) continue;
      const won = player.slot === input.championSlot;

      let prizeMicros = 0n;
      let balances = await ledger.readBalances(tx, player.userId);

      if (won && input.mode === 'PAID' && econ.prizeMicros > 0n) {
        const payout = await ledger.record(tx, {
          userId: player.userId,
          type: 'PRIZE',
          amountMicros: econ.prizeMicros,
          // Keyed on the match, not the player: a match has exactly one prize.
          idempotencyKey: ledgerKey('match', input.matchId, 'prize'),
          referenceType: 'match',
          referenceId: input.matchId,
          metadata: {
            entryMicros: econ.entryMicros.toString(),
            commissionTotalMicros: econ.commissionTotalMicros.toString(),
            netProfitMicros: (econ.prizeMicros - econ.entryMicros).toString(),
          },
        });
        if (!payout.duplicate) prizeMicros = econ.prizeMicros;
        balances = { available: payout.availableMicros, locked: payout.lockedMicros };

        await tx.query('UPDATE match_players SET prize_tx_id = $3 WHERE match_id = $1 AND slot = $2', [
          input.matchId,
          player.slot,
          payout.transactionId || null,
        ]);
      }

      const progression = await applyProgression(tx, {
        userId: player.userId,
        mode: input.mode,
        won,
        roundsWon: player.roundsWon,
        entryMicros: input.mode === 'PAID' ? econ.entryMicros : 0n,
        prizeMicros,
        settings,
      });

      results.push({
        slot: player.slot,
        userId: player.userId,
        won,
        prizeMicros,
        availableMicros: balances.available,
        lockedMicros: balances.locked,
        ...progression,
      });
    }

    await recordEvent(tx, {
      matchId: input.matchId,
      type: 'MATCH_SETTLED',
      payload: {
        championSlot: input.championSlot,
        prizeMicros: econ.prizeMicros.toString(),
        commissionMicros: econ.commissionTotalMicros.toString(),
      },
    });

    return results;
  });
}

interface ProgressionInput {
  userId: string;
  mode: GameMode;
  won: boolean;
  roundsWon: number;
  entryMicros: bigint;
  prizeMicros: bigint;
  settings: SettingsMap;
}

async function applyProgression(
  tx: Tx,
  input: ProgressionInput,
): Promise<{ xpGained: bigint; pointsGained: bigint; newLevel: number; levelUp: number | null }> {
  const { rows } = await tx.query<{ xp: string; level: number; current_streak: number }>(
    'SELECT xp, level, current_streak FROM player_progress WHERE user_id = $1 FOR UPDATE',
    [input.userId],
  );
  const current = rows[0];
  if (!current) {
    return { xpGained: 0n, pointsGained: 0n, newLevel: 1, levelUp: null };
  }

  const streak = input.won ? current.current_streak + 1 : 0;
  const rewards = computeRewards(
    { mode: input.mode as 'FREE' | 'PAID' | 'DEMO', won: input.won, roundsWon: input.roundsWon, streak },
    xpTable(input.settings),
    pointsTable(input.settings),
  );

  const newXp = toBigInt(current.xp) + rewards.xp;
  const level = levelFromXp(newXp, levelCurve(input.settings));
  const levelUp = level.level > current.level ? level.level : null;

  // Demo matches are excluded from every counter — they are practice, not record.
  const counts = input.mode === 'DEMO';

  await tx.query(
    `
    UPDATE player_progress SET
      xp                  = xp + $2,
      points              = GREATEST(points + $3, 0),
      level               = $4,
      total_matches       = total_matches + $5,
      wins                = wins   + $6,
      losses              = losses + $7,
      free_matches        = free_matches + $8,
      free_wins           = free_wins    + $9,
      paid_matches        = paid_matches + $10,
      paid_wins           = paid_wins    + $11,
      paid_wagered_micros = paid_wagered_micros + $12,
      paid_won_micros     = paid_won_micros     + $13,
      current_streak      = $14,
      best_streak         = GREATEST(best_streak, $14),
      updated_at          = now()
    WHERE user_id = $1
    `,
    [
      input.userId,
      rewards.xp.toString(),
      rewards.points.toString(),
      level.level,
      counts ? 0 : 1,
      !counts && input.won ? 1 : 0,
      !counts && !input.won ? 1 : 0,
      input.mode === 'FREE' ? 1 : 0,
      input.mode === 'FREE' && input.won ? 1 : 0,
      input.mode === 'PAID' ? 1 : 0,
      input.mode === 'PAID' && input.won ? 1 : 0,
      input.entryMicros.toString(),
      input.prizeMicros.toString(),
      streak,
    ],
  );

  return {
    xpGained: rewards.xp,
    pointsGained: rewards.points,
    newLevel: level.level,
    levelUp,
  };
}

export async function recordBestReaction(userId: string, reactionMs: number): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE player_progress
          SET best_reaction_ms = LEAST(COALESCE(best_reaction_ms, $2), $2)
        WHERE user_id = $1`,
      [userId, reactionMs],
    );
  }).catch((error) => logger.debug({ err: error }, 'best reaction update failed'));
}

/**
 * Cancel a match and return money.
 *
 * Handles both stages: if entries were never charged the lock is simply
 * released; if they were charged an explicit REFUND credit reverses them, so
 * the statement shows the full story rather than a silent adjustment.
 */
export async function cancelAndRefund(
  matchId: string,
  reason: string,
): Promise<{ userId: string; refundMicros: bigint; availableMicros: bigint }[]> {
  return withTransaction(async (tx) => {
    const { rows: matchRows } = await tx.query<{
      mode: string;
      entry_micros: string;
      settled: boolean;
      status: string;
    }>('SELECT mode, entry_micros, settled, status FROM matches WHERE id = $1 FOR UPDATE', [matchId]);

    const match = matchRows[0];
    if (!match || match.settled || match.status === 'CANCELLED') return [];

    const entryMicros = toBigInt(match.entry_micros);
    const { rows: players } = await tx.query<{
      slot: number;
      user_id: string | null;
      is_ai: boolean;
      entry_tx_id: string | null;
    }>('SELECT slot, user_id, is_ai, entry_tx_id FROM match_players WHERE match_id = $1', [matchId]);

    const refunds: { userId: string; refundMicros: bigint; availableMicros: bigint }[] = [];

    for (const player of players) {
      if (player.is_ai || !player.user_id || entryMicros <= 0n || match.mode !== 'PAID') continue;

      if (player.entry_tx_id) {
        const refund = await ledger.record(tx, {
          userId: player.user_id,
          type: 'REFUND',
          amountMicros: entryMicros,
          idempotencyKey: ledgerKey('match', matchId, 'refund', player.user_id),
          referenceType: 'match',
          referenceId: matchId,
          metadata: { reason },
        });
        await tx.query('UPDATE match_players SET refund_tx_id = $3 WHERE match_id = $1 AND slot = $2', [
          matchId,
          player.slot,
          refund.transactionId || null,
        ]);
        refunds.push({
          userId: player.user_id,
          refundMicros: refund.duplicate ? 0n : entryMicros,
          availableMicros: refund.availableMicros,
        });
      } else {
        // Never charged — just unreserve.
        const released = await ledger.releaseLock(tx, player.user_id, entryMicros);
        refunds.push({
          userId: player.user_id,
          refundMicros: entryMicros,
          availableMicros: released.availableMicros,
        });
      }
    }

    await tx.query(
      `UPDATE matches SET status = 'CANCELLED', settled = TRUE, cancel_reason = $2, finished_at = now()
        WHERE id = $1`,
      [matchId, reason],
    );
    await recordEvent(tx, { matchId, type: 'MATCH_CANCELLED', payload: { reason } });

    logger.info({ matchId, reason, refunded: refunds.length }, 'match cancelled and refunded');
    return refunds;
  });
}
