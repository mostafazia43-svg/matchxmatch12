import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings } from '../../config/settings.js';
import { query } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import {
  listTransactions,
  requestWithdrawal,
  setUserTonAddress,
  walletSummary,
} from '../../modules/wallet/service.js';
import { ok, rateLimit, requireAuth } from '../plugins.js';

const withdrawSchema = z.object({
  amountMicros: z.string().regex(/^\d{1,19}$/),
  toAddress: z.string().min(10).max(120),
  /** Client-generated, so a double-tap cannot create two withdrawals. */
  requestKey: z.string().min(8).max(64),
});

const addressSchema = z.object({ address: z.string().min(10).max(120) });

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/wallet', async (request) => {
    const user = await requireAuth(request);
    const [summary, settings] = await Promise.all([walletSummary(user.id), getSettings()]);
    return ok({
      ...summary,
      limits: {
        minDepositMicros: String(settings['wallet.min_deposit_micros']),
        minWithdrawalMicros: String(settings['wallet.min_withdrawal_micros']),
        withdrawalFeeMicros: String(settings['wallet.withdrawal_fee_micros']),
        depositsEnabled: settings['wallet.deposits_enabled'],
        withdrawalsEnabled: settings['wallet.withdrawals_enabled'],
      },
    });
  });

  app.get('/api/wallet/transactions', async (request) => {
    const user = await requireAuth(request);
    const params = request.query as { limit?: string; before?: string; types?: string };
    return ok(
      await listTransactions(user.id, {
        limit: Number(params.limit) || 30,
        before: params.before,
        types: params.types?.split(',').filter(Boolean),
      }),
    );
  });

  app.post('/api/wallet/address', async (request) => {
    const user = await requireAuth(request);
    const body = addressSchema.safeParse(request.body);
    if (!body.success) throw errors.validation('A TON address is required.');
    await setUserTonAddress(user.id, body.data.address);
    return ok(await walletSummary(user.id));
  });

  /**
   * Withdrawals are rate limited hard and always land in a review queue.
   * The debit happens immediately (see wallet/service.ts) so the balance
   * cannot be spent twice while the payout is pending.
   */
  app.post(
    '/api/wallet/withdraw',
    { preHandler: rateLimit({ limit: 5, windowMs: 60 * 60_000, scope: 'withdraw' }) },
    async (request) => {
      const user = await requireAuth(request);
      const body = withdrawSchema.safeParse(request.body);
      if (!body.success) throw errors.validation('Amount, address and requestKey are required.');

      const result = await requestWithdrawal({
        userId: user.id,
        amountMicros: BigInt(body.data.amountMicros),
        toAddress: body.data.toAddress,
        requestKey: body.data.requestKey,
      });

      return ok({
        withdrawalId: result.withdrawalId,
        availableMicros: result.availableMicros.toString(),
        status: 'PENDING',
        message: 'Withdrawal requested. It will be reviewed and paid out shortly.',
      });
    },
  );

  app.get('/api/wallet/withdrawals', async (request) => {
    const user = await requireAuth(request);
    const rows = await query<{
      id: string;
      to_address: string;
      amount_micros: string;
      fee_micros: string;
      status: string;
      chain_tx_hash: string | null;
      review_note: string | null;
      created_at: Date;
    }>(
      `SELECT id, to_address, amount_micros, fee_micros, status, chain_tx_hash,
              review_note, created_at
         FROM withdrawals WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 30`,
      [user.id],
    );

    return ok(
      rows.map((row) => ({
        id: row.id,
        toAddress: row.to_address,
        amountMicros: row.amount_micros,
        feeMicros: row.fee_micros,
        status: row.status,
        txHash: row.chain_tx_hash,
        note: row.review_note,
        createdAt: row.created_at.toISOString(),
      })),
    );
  });

  app.get('/api/wallet/deposits', async (request) => {
    const user = await requireAuth(request);
    const rows = await query<{
      id: string;
      chain_tx_hash: string;
      amount_micros: string;
      status: string;
      confirmations: number;
      created_at: Date;
    }>(
      `SELECT id, chain_tx_hash, amount_micros, status, confirmations, created_at
         FROM deposits WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 30`,
      [user.id],
    );

    return ok(
      rows.map((row) => ({
        id: row.id,
        txHash: row.chain_tx_hash,
        amountMicros: row.amount_micros,
        status: row.status,
        confirmations: row.confirmations,
        createdAt: row.created_at.toISOString(),
      })),
    );
  });
}
