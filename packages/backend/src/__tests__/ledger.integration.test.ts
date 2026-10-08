/**
 * Ledger integration tests.
 *
 * These exercise the real database, because the guarantees under test —
 * idempotency via a unique index, non-negative balances via a CHECK
 * constraint, atomicity via a transaction — live in Postgres, not in
 * TypeScript. Mocking them would test nothing.
 *
 * The suite SKIPS (rather than fails) when no database is reachable, so
 * `npm test` still works on a machine without Postgres. Run it for real with:
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://clickbattle:clickbattle@localhost:5432/clickbattle npm test
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeMatchEconomics, toMicros } from '@cb/shared';
import { closePool, pool, query, withTransaction } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { ledgerKey } from '../lib/ids.js';
import * as ledger from '../modules/wallet/ledger.js';
import { chargeEntries, settleMatch } from '../modules/game/settlement.js';
import { createMatch } from '../modules/game/store.js';

let dbAvailable = false;

async function makeUser(telegramId: bigint, balance: bigint): Promise<string> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (telegram_id, first_name) VALUES ($1, 'Test')
       ON CONFLICT (telegram_id) DO UPDATE SET first_name = 'Test'
       RETURNING id`,
      [telegramId.toString()],
    );
    const id = rows[0]!.id;
    await tx.query(
      `INSERT INTO wallets (user_id, available_micros) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET available_micros = $2, locked_micros = 0`,
      [id, balance.toString()],
    );
    await tx.query('INSERT INTO player_progress (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    return id;
  });
}

async function balanceOf(userId: string): Promise<{ available: bigint; locked: bigint }> {
  const rows = await query<{ available_micros: string; locked_micros: string }>(
    'SELECT available_micros, locked_micros FROM wallets WHERE user_id = $1',
    [userId],
  );
  return {
    available: BigInt(rows[0]?.available_micros ?? '0'),
    locked: BigInt(rows[0]?.locked_micros ?? '0'),
  };
}

beforeAll(async () => {
  try {
    await pool.query('SELECT 1');
    await runMigrations();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
}, 30_000);

afterAll(async () => {
  if (dbAvailable) await closePool().catch(() => undefined);
});

describe.skipIf(!dbAvailable)('ledger', () => {
  const base = 9_000_000_000n;
  let seq = 0;
  const nextTelegramId = () => base + BigInt(++seq);

  it('credits and debits exactly', async () => {
    const userId = await makeUser(nextTelegramId(), toMicros('100'));

    await withTransaction((tx) =>
      ledger.record(tx, {
        userId,
        type: 'DEPOSIT',
        amountMicros: toMicros('25.5'),
        idempotencyKey: ledgerKey('test-deposit', userId, Date.now()),
      }),
    );

    expect((await balanceOf(userId)).available).toBe(toMicros('125.5'));
  });

  it('is idempotent: the same key credits once, no matter how many times it runs', async () => {
    const userId = await makeUser(nextTelegramId(), 0n);
    const key = ledgerKey('test-idem', userId);

    for (let i = 0; i < 5; i++) {
      await withTransaction((tx) =>
        ledger.record(tx, {
          userId,
          type: 'DEPOSIT',
          amountMicros: toMicros('10'),
          idempotencyKey: key,
        }),
      );
    }

    expect((await balanceOf(userId)).available).toBe(toMicros('10'));
    const rows = await query('SELECT id FROM wallet_transactions WHERE idempotency_key = $1', [key]);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent under CONCURRENT writes, not just sequential retries', async () => {
    const userId = await makeUser(nextTelegramId(), 0n);
    const key = ledgerKey('test-race', userId);

    const attempts = Array.from({ length: 8 }, () =>
      withTransaction((tx) =>
        ledger.record(tx, {
          userId,
          type: 'PRIZE',
          amountMicros: toMicros('9.5'),
          idempotencyKey: key,
        }),
      ).catch(() => null),
    );
    await Promise.all(attempts);

    expect((await balanceOf(userId)).available).toBe(toMicros('9.5'));
  });

  it('refuses to let a balance go negative', async () => {
    const userId = await makeUser(nextTelegramId(), toMicros('5'));

    await expect(
      withTransaction((tx) =>
        ledger.record(tx, {
          userId,
          type: 'WITHDRAWAL',
          amountMicros: toMicros('-6'),
          idempotencyKey: ledgerKey('test-overdraw', userId),
        }),
      ),
    ).rejects.toThrow(/balance/i);

    // The failed attempt must leave nothing behind.
    expect((await balanceOf(userId)).available).toBe(toMicros('5'));
    const rows = await query('SELECT id FROM wallet_transactions WHERE idempotency_key = $1', [
      ledgerKey('test-overdraw', userId),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('locks and releases funds without changing the total', async () => {
    const userId = await makeUser(nextTelegramId(), toMicros('50'));

    await withTransaction((tx) => ledger.lockFunds(tx, userId, toMicros('30')));
    let balances = await balanceOf(userId);
    expect(balances.available).toBe(toMicros('20'));
    expect(balances.locked).toBe(toMicros('30'));
    expect(balances.available + balances.locked).toBe(toMicros('50'));

    await withTransaction((tx) => ledger.releaseLock(tx, userId, toMicros('30')));
    balances = await balanceOf(userId);
    expect(balances.available).toBe(toMicros('50'));
    expect(balances.locked).toBe(0n);
  });

  it('will not lock more than is available', async () => {
    const userId = await makeUser(nextTelegramId(), toMicros('5'));
    await expect(
      withTransaction((tx) => ledger.lockFunds(tx, userId, toMicros('10'))),
    ).rejects.toThrow(/balance/i);
    expect((await balanceOf(userId)).locked).toBe(0n);
  });

  it('cannot stake the same balance in two matches at once', async () => {
    const userId = await makeUser(nextTelegramId(), toMicros('5'));

    await withTransaction((tx) => ledger.lockFunds(tx, userId, toMicros('5')));
    await expect(
      withTransaction((tx) => ledger.lockFunds(tx, userId, toMicros('5'))),
    ).rejects.toThrow(/balance/i);
  });

  it('does not charge the player twice for the commission row', async () => {
    const userId = await makeUser(nextTelegramId(), toMicros('5'));
    const opponentId = await makeUser(nextTelegramId(), toMicros('5'));
    const entry = toMicros('5');

    await withTransaction((tx) => ledger.lockFunds(tx, userId, entry));
    await withTransaction((tx) => ledger.lockFunds(tx, opponentId, entry));

    const matchId = await withTransaction((tx) =>
      createMatch(tx, {
        mode: 'PAID',
        entryMicros: entry,
        commissionBps: 500,
        commissionMicros: toMicros('0.5'),
        prizeMicros: toMicros('9.5'),
        roundsToWin: 2,
        maxRounds: 3,
        isAiMatch: false,
        players: [
          { slot: 1, userId, isAi: false, displayName: 'A', avatarUrl: null, level: 1 },
          { slot: 2, userId: opponentId, isAi: false, displayName: 'B', avatarUrl: null, level: 1 },
        ],
      }),
    );

    await withTransaction((tx) =>
      chargeEntries(tx, {
        matchId,
        entryMicros: entry,
        commissionBps: 500,
        players: [
          { slot: 1, userId, isAi: false },
          { slot: 2, userId: opponentId, isAi: false },
        ],
      }),
    );

    // $5 in, $5 staked: available and locked are both zero. The COMMISSION row
    // explains the fee but must not debit again.
    const balances = await balanceOf(userId);
    expect(balances.available).toBe(0n);
    expect(balances.locked).toBe(0n);

    const commissionRows = await query<{ amount_micros: string; affects_balance: boolean }>(
      `SELECT amount_micros, affects_balance FROM wallet_transactions
        WHERE user_id = $1 AND type = 'COMMISSION'`,
      [userId],
    );
    expect(commissionRows).toHaveLength(1);
    expect(commissionRows[0]!.affects_balance).toBe(false);
    expect(BigInt(commissionRows[0]!.amount_micros)).toBe(-toMicros('0.25'));
  });

  it('pays the champion exactly the spec prize and settles only once', async () => {
    const winnerId = await makeUser(nextTelegramId(), toMicros('10'));
    const loserId = await makeUser(nextTelegramId(), toMicros('10'));
    const entry = toMicros('10');
    const econ = computeMatchEconomics(entry, 500);

    await withTransaction((tx) => ledger.lockFunds(tx, winnerId, entry));
    await withTransaction((tx) => ledger.lockFunds(tx, loserId, entry));

    const matchId = await withTransaction((tx) =>
      createMatch(tx, {
        mode: 'PAID',
        entryMicros: entry,
        commissionBps: 500,
        commissionMicros: econ.commissionTotalMicros,
        prizeMicros: econ.prizeMicros,
        roundsToWin: 2,
        maxRounds: 3,
        isAiMatch: false,
        players: [
          { slot: 1, userId: winnerId, isAi: false, displayName: 'W', avatarUrl: null, level: 1 },
          { slot: 2, userId: loserId, isAi: false, displayName: 'L', avatarUrl: null, level: 1 },
        ],
      }),
    );

    await withTransaction((tx) =>
      chargeEntries(tx, {
        matchId,
        entryMicros: entry,
        commissionBps: 500,
        players: [
          { slot: 1, userId: winnerId, isAi: false },
          { slot: 2, userId: loserId, isAi: false },
        ],
      }),
    );

    const settlementInput = {
      matchId,
      mode: 'PAID' as const,
      entryMicros: entry,
      commissionBps: 500,
      championSlot: 1 as const,
      players: [
        { slot: 1 as const, userId: winnerId, isAi: false, roundsWon: 2 },
        { slot: 2 as const, userId: loserId, isAi: false, roundsWon: 1 },
      ],
    };

    await settleMatch(settlementInput);
    // Re-running settlement (a retry, a duplicate event, a recovery sweep)
    // must not pay a second prize.
    await settleMatch(settlementInput);
    await settleMatch(settlementInput);

    // Started with $10, staked $10, won $19.
    expect((await balanceOf(winnerId)).available).toBe(econ.prizeMicros);
    expect((await balanceOf(loserId)).available).toBe(0n);

    const prizeRows = await query(
      `SELECT id FROM wallet_transactions WHERE reference_id = $1 AND type = 'PRIZE'`,
      [matchId],
    );
    expect(prizeRows).toHaveLength(1);
  });

  it('keeps the books balanced: every micro is accounted for', async () => {
    const a = await makeUser(nextTelegramId(), toMicros('30'));
    const b = await makeUser(nextTelegramId(), toMicros('30'));
    const entry = toMicros('30');
    const econ = computeMatchEconomics(entry, 500);

    await withTransaction((tx) => ledger.lockFunds(tx, a, entry));
    await withTransaction((tx) => ledger.lockFunds(tx, b, entry));

    const matchId = await withTransaction((tx) =>
      createMatch(tx, {
        mode: 'PAID',
        entryMicros: entry,
        commissionBps: 500,
        commissionMicros: econ.commissionTotalMicros,
        prizeMicros: econ.prizeMicros,
        roundsToWin: 2,
        maxRounds: 3,
        isAiMatch: false,
        players: [
          { slot: 1, userId: a, isAi: false, displayName: 'A', avatarUrl: null, level: 1 },
          { slot: 2, userId: b, isAi: false, displayName: 'B', avatarUrl: null, level: 1 },
        ],
      }),
    );

    await withTransaction((tx) =>
      chargeEntries(tx, {
        matchId,
        entryMicros: entry,
        commissionBps: 500,
        players: [
          { slot: 1, userId: a, isAi: false },
          { slot: 2, userId: b, isAi: false },
        ],
      }),
    );
    await settleMatch({
      matchId,
      mode: 'PAID',
      entryMicros: entry,
      commissionBps: 500,
      championSlot: 2,
      players: [
        { slot: 1, userId: a, isAi: false, roundsWon: 0 },
        { slot: 2, userId: b, isAi: false, roundsWon: 2 },
      ],
    });

    const playerTotal = (await balanceOf(a)).available + (await balanceOf(b)).available;
    // $60 went in; $57 came back to the winner; $3 is platform commission.
    expect(playerTotal).toBe(econ.prizeMicros);
    expect(playerTotal + econ.commissionTotalMicros).toBe(econ.grossMicros);
  });

  it('refunds both players when a match is cancelled after entries were charged', async () => {
    const { cancelAndRefund } = await import('../modules/game/settlement.js');
    const a = await makeUser(nextTelegramId(), toMicros('5'));
    const b = await makeUser(nextTelegramId(), toMicros('5'));
    const entry = toMicros('5');

    await withTransaction((tx) => ledger.lockFunds(tx, a, entry));
    await withTransaction((tx) => ledger.lockFunds(tx, b, entry));

    const matchId = await withTransaction((tx) =>
      createMatch(tx, {
        mode: 'PAID',
        entryMicros: entry,
        commissionBps: 500,
        commissionMicros: toMicros('0.5'),
        prizeMicros: toMicros('9.5'),
        roundsToWin: 2,
        maxRounds: 3,
        isAiMatch: false,
        players: [
          { slot: 1, userId: a, isAi: false, displayName: 'A', avatarUrl: null, level: 1 },
          { slot: 2, userId: b, isAi: false, displayName: 'B', avatarUrl: null, level: 1 },
        ],
      }),
    );

    await withTransaction((tx) =>
      chargeEntries(tx, {
        matchId,
        entryMicros: entry,
        commissionBps: 500,
        players: [
          { slot: 1, userId: a, isAi: false },
          { slot: 2, userId: b, isAi: false },
        ],
      }),
    );

    await cancelAndRefund(matchId, 'test cancellation');
    await cancelAndRefund(matchId, 'test cancellation'); // must not double-refund

    expect((await balanceOf(a)).available).toBe(toMicros('5'));
    expect((await balanceOf(b)).available).toBe(toMicros('5'));
  });
});
