/**
 * Deposit watcher.
 *
 * Polls the configured provider for incoming USDT transfers and hands each one
 * to `creditDeposit`, which is idempotent — so re-seeing the same transfer on
 * every poll is harmless. That is the whole design: the watcher is allowed to
 * be dumb and repetitive because the credit path is safe.
 */

import { env } from '../../config/env.js';
import { getSettings } from '../../config/settings.js';
import { logger } from '../../lib/logger.js';
import * as hub from '../../realtime/hub.js';
import { creditDeposit, walletSummary } from '../wallet/service.js';
import { tonProvider } from './provider.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

async function poll(): Promise<void> {
  if (running) return; // never overlap a slow poll with the next tick
  running = true;

  try {
    const settings = await getSettings();
    if (!settings['wallet.deposits_enabled']) return;

    const transfers = await tonProvider().listIncoming({ limit: 50 });
    for (const transfer of transfers) {
      try {
        const result = await creditDeposit(transfer);
        if (result.credited && result.userId) {
          const wallet = await walletSummary(result.userId);
          hub.sendTo(result.userId, {
            t: 'BALANCE_UPDATED',
            availableMicros: wallet.availableMicros,
            lockedMicros: wallet.lockedMicros,
            reason: 'DEPOSIT',
          });
        }
      } catch (error) {
        logger.error({ err: error, txHash: transfer.txHash }, 'failed to process a deposit');
      }
    }
  } catch (error) {
    logger.warn({ err: error }, 'deposit poll failed; will retry');
  } finally {
    running = false;
  }
}

export function startDepositWatcher(): void {
  if (timer) return;
  const interval = env.DEPOSIT_POLL_INTERVAL_MS;
  timer = setInterval(() => void poll(), interval);
  timer.unref();
  logger.info({ provider: tonProvider().name, intervalMs: interval }, 'deposit watcher started');
  void poll();
}

export function stopDepositWatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
