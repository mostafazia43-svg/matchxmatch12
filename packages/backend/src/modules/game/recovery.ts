/**
 * Crash recovery.
 *
 * A live match lives in memory. If the process dies, that memory is gone but
 * the money is not: entries may be charged, funds may be locked, and two
 * players are waiting for a result that will never arrive.
 *
 * This runs once at boot, before the server accepts traffic, and makes the
 * database consistent again: every non-terminal match is cancelled and
 * refunded, and every orphaned fund lock is released. Cancelling is the right
 * call rather than trying to resume — a half-finished reaction round cannot be
 * fairly reconstructed, and returning the stake is the outcome neither player
 * can be wronged by.
 */

import { logger } from '../../lib/logger.js';
import { reconcileOrphanedLocks } from '../matchmaking/service.js';
import { cancelAndRefund } from './settlement.js';
import { danglingMatches } from './store.js';

export interface RecoveryReport {
  cancelledMatches: number;
  refundedPlayers: number;
  releasedLocks: number;
}

export async function recoverFromRestart(): Promise<RecoveryReport> {
  const report: RecoveryReport = { cancelledMatches: 0, refundedPlayers: 0, releasedLocks: 0 };

  const dangling = await danglingMatches();
  if (dangling.length > 0) {
    logger.warn({ count: dangling.length }, 'found matches left open by a previous run');
  }

  for (const match of dangling) {
    try {
      const refunds = await cancelAndRefund(
        match.id,
        'Server restarted before the match finished. Your entry has been returned.',
      );
      report.cancelledMatches += 1;
      report.refundedPlayers += refunds.length;
    } catch (error) {
      // One bad match must not stop the rest of the sweep.
      logger.error({ err: error, matchId: match.id }, 'failed to recover a match');
    }
  }

  try {
    report.releasedLocks = await reconcileOrphanedLocks();
  } catch (error) {
    logger.error({ err: error }, 'failed to reconcile orphaned fund locks');
  }

  if (report.cancelledMatches || report.releasedLocks) {
    logger.info(report, 'recovery complete');
  }
  return report;
}
