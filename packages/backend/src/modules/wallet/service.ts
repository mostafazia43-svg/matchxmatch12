/**
 * Wallet service — balances, deposits, withdrawals, statements.
 *
 * Nothing here trusts a client-supplied amount or balance. Deposits are
 * credited only from a provider-observed on-chain transfer; withdrawals debit
 * first and pay out second, so a failed payout refunds rather than a
 * successful payout being un-recorded.
 */

import { DEPOSIT_MEMO_PREFIX, type TransactionView, type WalletSummary } from '@cb/shared';
import { env } from '../../config/env.js';
import { getSettings } from '../../config/settings.js';
import { query, queryOne, toBigInt, withTransaction, type Tx } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { ledgerKey } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { tonProvider, type IncomingTransfer } from '../payments/provider.js';
import * as ledger from './ledger.js';

/**
 * The memo a player must attach to an on-chain transfer so we can attribute it.
 * Derived from the user id, so it is stable, unguessable-in-bulk and needs no
 * extra storage.
 */
export function depositMemoFor(userId: string): string {
  return DEPOSIT_MEMO_PREFIX + userId.replace(/-/g, '').slice(0, 10).toUpperCase();
}

export async function walletSummary(userId: string): Promise<WalletSummary> {
  const row = await queryOne<{
    available_micros: string;
    locked_micros: string;
    total_deposited_micros: string;
    total_withdrawn_micros: string;
    ton_address: string | null;
  }>(
    `SELECT available_micros, locked_micros, total_deposited_micros,
            total_withdrawn_micros, ton_address
       FROM wallets WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw errors.notFound('Wallet not found.');

  return {
    availableMicros: row.available_micros,
    lockedMicros: row.locked_micros,
    totalDepositedMicros: row.total_deposited_micros,
    totalWithdrawnMicros: row.total_withdrawn_micros,
    currency: 'USDT',
    tonAddress: row.ton_address,
    depositAddress: env.PLATFORM_WALLET_ADDRESS,
    depositMemo: depositMemoFor(userId),
  };
}

export async function setUserTonAddress(userId: string, address: string): Promise<void> {
  const trimmed = address.trim();
  if (!tonProvider().isValidAddress(trimmed)) throw errors.invalidAddress();
  await queryOne('UPDATE wallets SET ton_address = $2, updated_at = now() WHERE user_id = $1', [
    userId,
    trimmed,
  ]);
}

export async function listTransactions(
  userId: string,
  options: { limit?: number; before?: string; types?: string[] } = {},
): Promise<TransactionView[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const params: (string | number)[] = [userId, limit];
  let where = 'user_id = $1';

  if (options.before) {
    params.push(options.before);
    where += ` AND created_at < $${params.length}`;
  }
  if (options.types?.length) {
    params.push(options.types.join(','));
    where += ` AND type = ANY(string_to_array($${params.length}, ','))`;
  }

  const rows = await query<{
    id: string;
    type: string;
    status: string;
    amount_micros: string;
    balance_after_micros: string | null;
    currency: string;
    reference_type: string | null;
    reference_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, type, status, amount_micros, balance_after_micros, currency,
            reference_type, reference_id, metadata, created_at
       FROM wallet_transactions
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $2`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type as TransactionView['type'],
    status: row.status as TransactionView['status'],
    amountMicros: row.amount_micros,
    balanceAfterMicros: row.balance_after_micros,
    currency: row.currency,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------- deposits

/**
 * Credit an observed on-chain transfer.
 *
 * Double-credit is prevented twice over: `deposits.chain_tx_hash` is UNIQUE,
 * and the ledger write is keyed on the same hash. Either guard alone would
 * do — both are here because crediting money twice is unrecoverable.
 */
export async function creditDeposit(transfer: IncomingTransfer): Promise<
  { credited: boolean; reason?: string; userId?: string }
> {
  const settings = await getSettings();
  const minimum = BigInt(settings['wallet.min_deposit_micros']);
  const requiredConfirmations = settings['wallet.required_confirmations'];

  if (transfer.confirmations < requiredConfirmations) {
    return { credited: false, reason: 'AWAITING_CONFIRMATIONS' };
  }

  const memo = (transfer.comment ?? '').trim().toUpperCase();
  const userId = memo.startsWith(DEPOSIT_MEMO_PREFIX)
    ? await userIdForMemo(memo)
    : null;

  return withTransaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `
      INSERT INTO deposits (user_id, chain_tx_hash, from_address, to_address,
                            amount_micros, comment, status, confirmations, raw, chain_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      ON CONFLICT (chain_tx_hash) DO NOTHING
      RETURNING id
      `,
      [
        userId,
        transfer.txHash,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.amountMicros.toString(),
        transfer.comment,
        userId ? 'CONFIRMED' : 'ORPHANED',
        transfer.confirmations,
        JSON.stringify(transfer.raw),
        transfer.timestamp,
      ],
    );

    const depositId = inserted.rows[0]?.id;
    if (!depositId) return { credited: false, reason: 'ALREADY_SEEN' };

    if (!userId) {
      // Money arrived that we cannot attribute. It is recorded as ORPHANED for
      // an admin to resolve manually — never silently discarded, never guessed.
      logger.warn({ txHash: transfer.txHash }, 'deposit has no matching memo; flagged for admin review');
      return { credited: false, reason: 'UNATTRIBUTED' };
    }

    if (transfer.amountMicros < minimum) {
      await tx.query(`UPDATE deposits SET status = 'ORPHANED', updated_at = now() WHERE id = $1`, [
        depositId,
      ]);
      return { credited: false, reason: 'BELOW_MINIMUM', userId };
    }

    const result = await ledger.record(tx, {
      userId,
      type: 'DEPOSIT',
      amountMicros: transfer.amountMicros,
      idempotencyKey: ledgerKey('deposit', transfer.txHash),
      referenceType: 'deposit',
      referenceId: depositId,
      metadata: {
        txHash: transfer.txHash,
        fromAddress: transfer.fromAddress,
        network: env.TON_NETWORK,
      },
    });

    await tx.query(
      `UPDATE deposits SET status = 'CREDITED', credited_tx_id = $2, updated_at = now() WHERE id = $1`,
      [depositId, result.transactionId],
    );

    logger.info({ userId, amount: transfer.amountMicros.toString() }, 'deposit credited');
    return { credited: !result.duplicate, userId };
  });
}

async function userIdForMemo(memo: string): Promise<string | null> {
  const suffix = memo.slice(DEPOSIT_MEMO_PREFIX.length).toLowerCase();
  if (!/^[0-9a-f]{10}$/.test(suffix)) return null;

  const rows = await query<{ id: string }>(
    `SELECT id FROM users WHERE left(replace(id::text, '-', ''), 10) = $1 LIMIT 2`,
    [suffix],
  );
  // A 40-bit prefix collision is astronomically unlikely, but crediting the
  // wrong player's wallet is unrecoverable — so an ambiguous memo goes to
  // manual review rather than to a coin flip.
  if (rows.length !== 1) {
    if (rows.length > 1) logger.error({ memo }, 'deposit memo matched multiple users');
    return null;
  }
  return rows[0]!.id;
}

// ---------------------------------------------------------------- withdrawals

export interface WithdrawalRequest {
  userId: string;
  amountMicros: bigint;
  toAddress: string;
  /** Client-supplied key so a double-tap cannot create two withdrawals. */
  requestKey: string;
}

/**
 * Request a withdrawal.
 *
 * The debit happens NOW, not at payout time. A player must not be able to
 * spend the same balance in a match while a withdrawal for it is queued. If
 * the payout is later rejected or fails, an explicit REFUND credit reverses it.
 */
export async function requestWithdrawal(request: WithdrawalRequest): Promise<{
  withdrawalId: string;
  availableMicros: bigint;
}> {
  const settings = await getSettings();
  if (!settings['wallet.withdrawals_enabled']) throw errors.withdrawalsDisabled();

  const minimum = BigInt(settings['wallet.min_withdrawal_micros']);
  const fee = BigInt(settings['wallet.withdrawal_fee_micros']);

  if (request.amountMicros < minimum) throw errors.amountTooSmall(minimum);
  if (request.amountMicros <= fee) {
    throw errors.validation('The withdrawal amount must be greater than the network fee.');
  }
  if (!tonProvider().isValidAddress(request.toAddress)) throw errors.invalidAddress();

  const idempotencyKey = ledgerKey('withdrawal', request.userId, request.requestKey);

  return withTransaction(async (tx) => {
    await ledger.lockWallet(tx, request.userId);

    const inserted = await tx.query<{ id: string }>(
      `
      INSERT INTO withdrawals (user_id, to_address, amount_micros, fee_micros, idempotency_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
      `,
      [
        request.userId,
        request.toAddress.trim(),
        request.amountMicros.toString(),
        fee.toString(),
        idempotencyKey,
      ],
    );

    const withdrawalId = inserted.rows[0]?.id;
    if (!withdrawalId) throw errors.duplicateRequest();

    // One row, CONFIRMED, debiting immediately. The `withdrawals.status`
    // column — not the ledger row — tracks whether the payout has been sent.
    const applied = await ledger.record(tx, {
      userId: request.userId,
      type: 'WITHDRAWAL',
      amountMicros: -request.amountMicros,
      idempotencyKey: ledgerKey('withdrawal-debit', withdrawalId),
      referenceType: 'withdrawal',
      referenceId: withdrawalId,
      metadata: { toAddress: request.toAddress, feeMicros: fee.toString() },
    });

    await tx.query('UPDATE withdrawals SET hold_tx_id = $2 WHERE id = $1', [
      withdrawalId,
      applied.transactionId,
    ]);

    logger.info(
      { userId: request.userId, withdrawalId, amount: request.amountMicros.toString() },
      'withdrawal requested',
    );
    return { withdrawalId, availableMicros: applied.availableMicros };
  });
}

/** Refund a withdrawal that was rejected or failed to send. */
export async function refundWithdrawal(
  tx: Tx,
  withdrawalId: string,
  reason: string,
): Promise<void> {
  const { rows } = await tx.query<{ user_id: string; amount_micros: string; status: string }>(
    'SELECT user_id, amount_micros, status FROM withdrawals WHERE id = $1 FOR UPDATE',
    [withdrawalId],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('Withdrawal not found.');

  const refund = await ledger.record(tx, {
    userId: row.user_id,
    type: 'REFUND',
    amountMicros: toBigInt(row.amount_micros),
    idempotencyKey: ledgerKey('withdrawal-refund', withdrawalId),
    referenceType: 'withdrawal',
    referenceId: withdrawalId,
    metadata: { reason },
  });

  await tx.query('UPDATE withdrawals SET refund_tx_id = $2, updated_at = now() WHERE id = $1', [
    withdrawalId,
    refund.transactionId,
  ]);
}
