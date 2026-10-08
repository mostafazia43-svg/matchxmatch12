/**
 * The ledger. Every micro-USDT that moves, moves through this file.
 *
 * Three invariants hold here and are relied on everywhere else:
 *
 *  1. APPEND-ONLY. A `wallet_transactions` row is written once. The only later
 *     mutation is stamping `balance_after_micros`/`settled_at` on the row just
 *     inserted, or moving a PENDING row to a terminal status.
 *
 *  2. IDEMPOTENT. Every write carries a deterministic `idempotency_key`. The
 *     insert happens BEFORE the balance moves, so a duplicate is detected by
 *     the unique index and returns early without touching the balance. A
 *     retried prize payout credits once, not twice.
 *
 *  3. NON-NEGATIVE. `wallets.available_micros >= 0` is a database CHECK, not an
 *     application `if`. Even a bug that computes a bad debit fails the
 *     transaction rather than creating money.
 *
 * Callers must already be inside `withTransaction` — that is what makes the
 * ledger row and the balance move atomic.
 */

import type { TransactionStatus, TransactionType } from '@cb/shared';
import { isCheckViolation, isUniqueViolation, toBigInt, type Tx } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface LedgerWrite {
  userId: string;
  type: TransactionType;
  /** Signed: negative debits the player, positive credits them. */
  amountMicros: bigint;
  idempotencyKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
  status?: TransactionStatus;
  /** FALSE writes an explanatory row without moving the balance. */
  affectsBalance?: boolean;
}

export interface LedgerResult {
  transactionId: string;
  /** True when this exact operation had already been recorded. */
  duplicate: boolean;
  availableMicros: bigint;
  lockedMicros: bigint;
}

interface WalletRow {
  available_micros: string;
  locked_micros: string;
}

/** Current balances, locking the wallet row for the rest of the transaction. */
export async function lockWallet(tx: Tx, userId: string): Promise<{ available: bigint; locked: bigint }> {
  const { rows } = await tx.query<WalletRow>(
    'SELECT available_micros, locked_micros FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('Wallet not found for this account.');
  return { available: toBigInt(row.available_micros), locked: toBigInt(row.locked_micros) };
}

export async function readBalances(
  tx: Tx,
  userId: string,
): Promise<{ available: bigint; locked: bigint }> {
  const { rows } = await tx.query<WalletRow>(
    'SELECT available_micros, locked_micros FROM wallets WHERE user_id = $1',
    [userId],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('Wallet not found for this account.');
  return { available: toBigInt(row.available_micros), locked: toBigInt(row.locked_micros) };
}

/**
 * Record a money movement.
 *
 * Order is deliberate: ledger row first (so the unique index arbitrates
 * duplicates), balance second. Reversing it would let a retry double-apply the
 * balance before failing on the insert.
 */
export async function record(tx: Tx, write: LedgerWrite): Promise<LedgerResult> {
  if (write.amountMicros === 0n) {
    throw errors.internal('Refusing to write a zero-amount ledger row.');
  }

  const affectsBalance = write.affectsBalance ?? true;
  const status = write.status ?? 'CONFIRMED';

  let inserted: { id: string } | undefined;
  try {
    const result = await tx.query<{ id: string }>(
      `
      INSERT INTO wallet_transactions
        (user_id, type, status, amount_micros, idempotency_key,
         reference_type, reference_id, metadata, affects_balance)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
      `,
      [
        write.userId,
        write.type,
        status,
        write.amountMicros.toString(),
        write.idempotencyKey,
        write.referenceType ?? null,
        write.referenceId ?? null,
        JSON.stringify(write.metadata ?? {}),
        affectsBalance,
      ],
    );
    inserted = result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) inserted = undefined;
    else throw error;
  }

  if (!inserted) {
    // Already processed. Report the existing row and leave the balance alone.
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM wallet_transactions WHERE idempotency_key = $1',
      [write.idempotencyKey],
    );
    const balances = await readBalances(tx, write.userId);
    logger.debug({ key: write.idempotencyKey }, 'ledger write ignored as duplicate');
    return {
      transactionId: existing.rows[0]?.id ?? '',
      duplicate: true,
      availableMicros: balances.available,
      lockedMicros: balances.locked,
    };
  }

  if (!affectsBalance || status !== 'CONFIRMED') {
    const balances = await readBalances(tx, write.userId);
    return {
      transactionId: inserted.id,
      duplicate: false,
      availableMicros: balances.available,
      lockedMicros: balances.locked,
    };
  }

  let updated: WalletRow | undefined;
  try {
    const result = await tx.query<WalletRow>(
      `
      UPDATE wallets
         SET available_micros = available_micros + $2,
             total_deposited_micros = total_deposited_micros + $3,
             total_withdrawn_micros = total_withdrawn_micros + $4,
             updated_at = now()
       WHERE user_id = $1
      RETURNING available_micros, locked_micros
      `,
      [
        write.userId,
        write.amountMicros.toString(),
        (write.type === 'DEPOSIT' && write.amountMicros > 0n ? write.amountMicros : 0n).toString(),
        (write.type === 'WITHDRAWAL' && write.amountMicros < 0n ? -write.amountMicros : 0n).toString(),
      ],
    );
    updated = result.rows[0];
  } catch (error) {
    if (isCheckViolation(error)) {
      // The database refused to let the balance go negative.
      const balances = await readBalances(tx, write.userId);
      throw errors.insufficientBalance(-write.amountMicros, balances.available);
    }
    throw error;
  }

  if (!updated) throw errors.notFound('Wallet not found for this account.');

  const available = toBigInt(updated.available_micros);
  await tx.query(
    'UPDATE wallet_transactions SET balance_after_micros = $2, settled_at = now() WHERE id = $1',
    [inserted.id, available.toString()],
  );

  return {
    transactionId: inserted.id,
    duplicate: false,
    availableMicros: available,
    lockedMicros: toBigInt(updated.locked_micros),
  };
}

/**
 * Reserve funds for a match entry: available -> locked.
 *
 * Reserved money is still the player's — no ledger row is written, because
 * nothing has been spent yet. It is simply unavailable for a second
 * simultaneous entry or a withdrawal, which is what prevents a player from
 * staking the same $5 in two matches at once.
 */
export async function lockFunds(tx: Tx, userId: string, amountMicros: bigint): Promise<LedgerResult> {
  if (amountMicros <= 0n) throw errors.internal('Lock amount must be positive.');

  try {
    const { rows } = await tx.query<WalletRow>(
      `
      UPDATE wallets
         SET available_micros = available_micros - $2,
             locked_micros    = locked_micros + $2,
             updated_at = now()
       WHERE user_id = $1
      RETURNING available_micros, locked_micros
      `,
      [userId, amountMicros.toString()],
    );
    const row = rows[0];
    if (!row) throw errors.notFound('Wallet not found for this account.');
    return {
      transactionId: '',
      duplicate: false,
      availableMicros: toBigInt(row.available_micros),
      lockedMicros: toBigInt(row.locked_micros),
    };
  } catch (error) {
    if (isCheckViolation(error)) {
      const balances = await readBalances(tx, userId);
      throw errors.insufficientBalance(amountMicros, balances.available);
    }
    throw error;
  }
}

/** Give reserved funds back: locked -> available. Used when a match never starts. */
export async function releaseLock(tx: Tx, userId: string, amountMicros: bigint): Promise<LedgerResult> {
  if (amountMicros <= 0n) throw errors.internal('Release amount must be positive.');

  const { rows } = await tx.query<WalletRow>(
    `
    UPDATE wallets
       SET locked_micros    = GREATEST(locked_micros - $2, 0),
           available_micros = available_micros + LEAST(locked_micros, $2),
           updated_at = now()
     WHERE user_id = $1
    RETURNING available_micros, locked_micros
    `,
    [userId, amountMicros.toString()],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('Wallet not found for this account.');
  return {
    transactionId: '',
    duplicate: false,
    availableMicros: toBigInt(row.available_micros),
    lockedMicros: toBigInt(row.locked_micros),
  };
}

/**
 * Consume reserved funds: the entry is now genuinely spent.
 * Writes the MATCH_ENTRY debit against locked money, so `available` is
 * untouched — it was already reduced when the funds were locked.
 */
export async function consumeLock(
  tx: Tx,
  write: Omit<LedgerWrite, 'affectsBalance'> & { amountMicros: bigint },
): Promise<LedgerResult> {
  const amount = write.amountMicros < 0n ? -write.amountMicros : write.amountMicros;

  let inserted: { id: string } | undefined;
  try {
    const result = await tx.query<{ id: string }>(
      `
      INSERT INTO wallet_transactions
        (user_id, type, status, amount_micros, idempotency_key,
         reference_type, reference_id, metadata, affects_balance)
      VALUES ($1, $2, 'CONFIRMED', $3, $4, $5, $6, $7::jsonb, TRUE)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
      `,
      [
        write.userId,
        write.type,
        (-amount).toString(),
        write.idempotencyKey,
        write.referenceType ?? null,
        write.referenceId ?? null,
        JSON.stringify(write.metadata ?? {}),
      ],
    );
    inserted = result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) inserted = undefined;
    else throw error;
  }

  if (!inserted) {
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM wallet_transactions WHERE idempotency_key = $1',
      [write.idempotencyKey],
    );
    const balances = await readBalances(tx, write.userId);
    return {
      transactionId: existing.rows[0]?.id ?? '',
      duplicate: true,
      availableMicros: balances.available,
      lockedMicros: balances.locked,
    };
  }

  const { rows } = await tx.query<WalletRow>(
    `
    UPDATE wallets
       SET locked_micros = GREATEST(locked_micros - $2, 0),
           updated_at = now()
     WHERE user_id = $1
    RETURNING available_micros, locked_micros
    `,
    [write.userId, amount.toString()],
  );
  const row = rows[0];
  if (!row) throw errors.notFound('Wallet not found for this account.');

  const available = toBigInt(row.available_micros);
  await tx.query(
    'UPDATE wallet_transactions SET balance_after_micros = $2, settled_at = now() WHERE id = $1',
    [inserted.id, available.toString()],
  );

  return {
    transactionId: inserted.id,
    duplicate: false,
    availableMicros: available,
    lockedMicros: toBigInt(row.locked_micros),
  };
}

/** Move a PENDING row (e.g. an unconfirmed deposit) to a terminal status. */
export async function settlePending(
  tx: Tx,
  transactionId: string,
  status: Extract<TransactionStatus, 'CONFIRMED' | 'FAILED' | 'CANCELLED'>,
): Promise<void> {
  await tx.query(
    `UPDATE wallet_transactions
        SET status = $2, settled_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [transactionId, status],
  );
}
