/**
 * Admin API.
 *
 * Every route here is behind `requireAdmin`, which re-derives admin status
 * from ADMIN_TELEGRAM_IDS on each request. Every state-changing route writes
 * an `admin_actions` row BEFORE returning, so there is no privileged action
 * without an audit trail — including the ones that move money.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSettings, setSetting, settingsSchema, type SettingKey } from '../../config/settings.js';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { ledgerKey } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { revokeAllSessions, type AuthedUser } from '../../modules/auth/service.js';
import * as engine from '../../modules/game/engine.js';
import { cancelAndRefund } from '../../modules/game/settlement.js';
import * as matchmaking from '../../modules/matchmaking/service.js';
import { mockProvider, tonProvider } from '../../modules/payments/provider.js';
import * as ledger from '../../modules/wallet/ledger.js';
import { refundWithdrawal } from '../../modules/wallet/service.js';
import * as hub from '../../realtime/hub.js';
import { ok, requireAdmin } from '../plugins.js';

async function audit(
  admin: AuthedUser,
  request: FastifyRequest,
  action: string,
  target: { type?: string; id?: string } = {},
  payload: Record<string, unknown> = {},
): Promise<void> {
  await queryOne(
    `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, payload, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [admin.id, action, target.type ?? null, target.id ?? null, JSON.stringify(payload), request.ip],
  );
  logger.info({ adminId: admin.id, action, target }, 'admin action');
}

const blockSchema = z.object({ blocked: z.boolean(), reason: z.string().max(280).optional() });
const adjustSchema = z.object({
  amountMicros: z.string().regex(/^-?\d{1,19}$/),
  reason: z.string().min(3).max(280),
  requestKey: z.string().min(8).max(64),
});
const reviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'MARK_SENT']),
  note: z.string().max(280).optional(),
  txHash: z.string().max(200).optional(),
});
const settingSchema = z.object({ key: z.string().min(1), value: z.unknown() });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- dashboard

  app.get('/api/admin/dashboard', async (request) => {
    await requireAdmin(request);

    const [users, matches, money, suspicious] = await Promise.all([
      queryOne<{
        total: string;
        active_24h: string;
        new_24h: string;
        blocked: string;
      }>(`
        SELECT COUNT(*)                                                       AS total,
               COUNT(*) FILTER (WHERE last_seen_at > now() - interval '24 hours') AS active_24h,
               COUNT(*) FILTER (WHERE created_at   > now() - interval '24 hours') AS new_24h,
               COUNT(*) FILTER (WHERE is_blocked)                              AS blocked
          FROM users
      `),
      queryOne<{
        total: string;
        active: string;
        free: string;
        paid: string;
        demo: string;
        today: string;
      }>(`
        SELECT COUNT(*)                                                   AS total,
               COUNT(*) FILTER (WHERE status NOT IN ('MATCH_FINISHED','CANCELLED')) AS active,
               COUNT(*) FILTER (WHERE mode = 'FREE')                       AS free,
               COUNT(*) FILTER (WHERE mode = 'PAID')                       AS paid,
               COUNT(*) FILTER (WHERE mode = 'DEMO')                       AS demo,
               COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS today
          FROM matches
      `),
      queryOne<{
        deposits: string;
        withdrawals: string;
        commission: string;
        prizes: string;
        held: string;
        locked: string;
      }>(`
        SELECT
          COALESCE((SELECT SUM(amount_micros) FROM wallet_transactions
                     WHERE type='DEPOSIT' AND status='CONFIRMED'), 0)         AS deposits,
          COALESCE((SELECT -SUM(amount_micros) FROM wallet_transactions
                     WHERE type='WITHDRAWAL' AND status='CONFIRMED'), 0)      AS withdrawals,
          COALESCE((SELECT -SUM(amount_micros) FROM wallet_transactions
                     WHERE type='COMMISSION'), 0)                             AS commission,
          COALESCE((SELECT SUM(amount_micros) FROM wallet_transactions
                     WHERE type='PRIZE'), 0)                                  AS prizes,
          COALESCE((SELECT SUM(available_micros) FROM wallets), 0)            AS held,
          COALESCE((SELECT SUM(locked_micros) FROM wallets), 0)               AS locked
      `),
      queryOne<{ open: string; pending_withdrawals: string; orphan_deposits: string }>(`
        SELECT
          (SELECT COUNT(*) FROM suspicious_events WHERE resolved = FALSE)     AS open,
          (SELECT COUNT(*) FROM withdrawals WHERE status = 'PENDING')         AS pending_withdrawals,
          (SELECT COUNT(*) FROM deposits WHERE status = 'ORPHANED')           AS orphan_deposits
      `),
    ]);

    return ok({
      users: {
        total: Number(users?.total ?? 0),
        active24h: Number(users?.active_24h ?? 0),
        new24h: Number(users?.new_24h ?? 0),
        blocked: Number(users?.blocked ?? 0),
        online: hub.onlineUserCount(),
      },
      matches: {
        total: Number(matches?.total ?? 0),
        active: Number(matches?.active ?? 0),
        live: engine.liveMatchCount(),
        free: Number(matches?.free ?? 0),
        paid: Number(matches?.paid ?? 0),
        demo: Number(matches?.demo ?? 0),
        today: Number(matches?.today ?? 0),
        queued: matchmaking.queueSize(),
        queueBreakdown: matchmaking.queueBreakdown(),
      },
      money: {
        depositsMicros: money?.deposits ?? '0',
        withdrawalsMicros: money?.withdrawals ?? '0',
        commissionMicros: money?.commission ?? '0',
        prizesMicros: money?.prizes ?? '0',
        userBalancesMicros: money?.held ?? '0',
        lockedMicros: money?.locked ?? '0',
      },
      alerts: {
        openSuspicious: Number(suspicious?.open ?? 0),
        pendingWithdrawals: Number(suspicious?.pending_withdrawals ?? 0),
        orphanDeposits: Number(suspicious?.orphan_deposits ?? 0),
      },
      provider: { name: tonProvider().name, live: tonProvider().live },
    });
  });

  // ---------------------------------------------------------------- users

  app.get('/api/admin/users', async (request) => {
    await requireAdmin(request);
    const params = request.query as { q?: string; limit?: string; blocked?: string };
    const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);
    const search = params.q?.trim() ?? '';

    const rows = await query(
      `
      SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name, u.photo_url,
             u.is_blocked, u.blocked_reason, u.created_at, u.last_seen_at,
             w.available_micros, w.locked_micros,
             p.level, p.xp, p.points, p.total_matches, p.wins, p.losses,
             p.paid_matches, p.paid_wagered_micros, p.paid_won_micros
        FROM users u
        LEFT JOIN wallets w         ON w.user_id = u.id
        LEFT JOIN player_progress p ON p.user_id = u.id
       WHERE ($1 = '' OR u.username ILIKE '%' || $1 || '%'
                     OR u.first_name ILIKE '%' || $1 || '%'
                     OR u.telegram_id::text = $1)
         AND ($3::boolean IS NULL OR u.is_blocked = $3)
       ORDER BY u.last_seen_at DESC
       LIMIT $2
      `,
      [search, limit, params.blocked === undefined ? null : params.blocked === 'true'],
    );

    return ok(rows);
  });

  app.get('/api/admin/users/:id', async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };

    const user = await queryOne(
      `SELECT u.*, w.available_micros, w.locked_micros, w.ton_address,
              w.total_deposited_micros, w.total_withdrawn_micros,
              p.level, p.xp, p.points, p.total_matches, p.wins, p.losses,
              p.paid_matches, p.paid_wagered_micros, p.paid_won_micros,
              p.best_reaction_ms, p.current_streak, p.best_streak
         FROM users u
         LEFT JOIN wallets w         ON w.user_id = u.id
         LEFT JOIN player_progress p ON p.user_id = u.id
        WHERE u.id = $1`,
      [id],
    );
    if (!user) throw errors.notFound('User not found.');

    const [transactions, matches, flags] = await Promise.all([
      query(
        `SELECT id, type, status, amount_micros, balance_after_micros, created_at, metadata
           FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id],
      ),
      query(
        `SELECT m.id, m.short_code, m.mode, m.status, m.entry_micros, m.prize_micros,
                m.winner_slot, mp.slot, mp.rounds_won, m.created_at
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = $1 ORDER BY m.created_at DESC LIMIT 30`,
        [id],
      ),
      query(
        `SELECT id, kind, severity, detail, resolved, created_at
           FROM suspicious_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [id],
      ),
    ]);

    return ok({ user, transactions, matches, flags, online: hub.isOnline(id) });
  });

  app.post('/api/admin/users/:id/block', async (request) => {
    const admin = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = blockSchema.safeParse(request.body);
    if (!body.success) throw errors.validation('blocked is required.');

    if (id === admin.id && body.data.blocked) {
      throw errors.validation('You cannot block your own account.');
    }

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE users
            SET is_blocked = $2,
                blocked_reason = $3,
                blocked_at = CASE WHEN $2 THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [id, body.data.blocked, body.data.reason ?? null],
      );
      // A blocked player must lose their live sessions, not merely fail the
      // next login.
      if (body.data.blocked) await revokeAllSessions(id, tx);
    });

    if (body.data.blocked) {
      await matchmaking.leave(id, 'BLOCKED').catch(() => undefined);
      for (const connection of hub.connectionsFor(id)) connection.socket.close(4003, 'blocked');
    }

    await audit(admin, request, body.data.blocked ? 'USER_BLOCK' : 'USER_UNBLOCK', {
      type: 'user',
      id,
    }, { reason: body.data.reason });

    return ok({ blocked: body.data.blocked });
  });

  /**
   * Manual balance adjustment.
   *
   * Goes through the same ledger as everything else — it is an
   * ADMIN_ADJUSTMENT row with an idempotency key and a mandatory reason, not a
   * direct UPDATE on the balance. That is what keeps the ledger a complete
   * explanation of every wallet.
   */
  app.post('/api/admin/users/:id/adjust', async (request) => {
    const admin = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = adjustSchema.safeParse(request.body);
    if (!body.success) throw errors.validation('amountMicros, reason and requestKey are required.');

    const amount = BigInt(body.data.amountMicros);
    if (amount === 0n) throw errors.validation('Adjustment amount cannot be zero.');

    const result = await withTransaction(async (tx) => {
      await ledger.lockWallet(tx, id);
      return ledger.record(tx, {
        userId: id,
        type: 'ADMIN_ADJUSTMENT',
        amountMicros: amount,
        idempotencyKey: ledgerKey('admin-adjust', id, body.data.requestKey),
        referenceType: 'admin',
        referenceId: admin.id,
        metadata: { reason: body.data.reason, adminId: admin.id },
      });
    });

    await audit(admin, request, 'BALANCE_ADJUST', { type: 'user', id }, {
      amountMicros: body.data.amountMicros,
      reason: body.data.reason,
      duplicate: result.duplicate,
    });

    hub.sendTo(id, {
      t: 'BALANCE_UPDATED',
      availableMicros: result.availableMicros.toString(),
      lockedMicros: result.lockedMicros.toString(),
      reason: 'ADMIN_ADJUSTMENT',
    });

    return ok({
      transactionId: result.transactionId,
      duplicate: result.duplicate,
      availableMicros: result.availableMicros.toString(),
    });
  });

  // ---------------------------------------------------------------- withdrawals

  app.get('/api/admin/withdrawals', async (request) => {
    await requireAdmin(request);
    const params = request.query as { status?: string };
    const rows = await query(
      `SELECT w.*, u.username, u.telegram_id, u.first_name
         FROM withdrawals w JOIN users u ON u.id = w.user_id
        WHERE ($1::text IS NULL OR w.status = $1)
        ORDER BY w.created_at DESC LIMIT 100`,
      [params.status ?? null],
    );
    return ok(rows);
  });

  app.post('/api/admin/withdrawals/:id/review', async (request) => {
    const admin = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = reviewSchema.safeParse(request.body);
    if (!body.success) throw errors.validation('decision is required.');

    const current = await queryOne<{ status: string; user_id: string }>(
      'SELECT status, user_id FROM withdrawals WHERE id = $1',
      [id],
    );
    if (!current) throw errors.notFound('Withdrawal not found.');

    if (body.data.decision === 'REJECT') {
      if (current.status === 'SENT') {
        throw errors.invalidState('This withdrawal was already sent and cannot be rejected.');
      }
      await withTransaction(async (tx) => {
        await refundWithdrawal(tx, id, body.data.note ?? 'Rejected by administrator');
        await tx.query(
          `UPDATE withdrawals
              SET status='REJECTED', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now()
            WHERE id = $1`,
          [id, admin.id, body.data.note ?? null],
        );
      });
    } else if (body.data.decision === 'APPROVE') {
      await queryOne(
        `UPDATE withdrawals
            SET status='APPROVED', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now()
          WHERE id = $1 AND status = 'PENDING'`,
        [id, admin.id, body.data.note ?? null],
      );
    } else {
      // MARK_SENT — the operator paid out manually and is recording the hash.
      await queryOne(
        `UPDATE withdrawals
            SET status='SENT', chain_tx_hash=$3, reviewed_by=$2, reviewed_at=now(), updated_at=now()
          WHERE id = $1`,
        [id, admin.id, body.data.txHash ?? null],
      );
    }

    await audit(admin, request, `WITHDRAWAL_${body.data.decision}`, { type: 'withdrawal', id }, {
      note: body.data.note,
      txHash: body.data.txHash,
    });

    return ok({ status: body.data.decision });
  });

  // ---------------------------------------------------------------- matches

  app.get('/api/admin/matches', async (request) => {
    await requireAdmin(request);
    const params = request.query as { status?: string; mode?: string; limit?: string };
    const limit = Math.min(Math.max(Number(params.limit) || 40, 1), 100);
    const rows = await query(
      `SELECT m.*,
              (SELECT json_agg(json_build_object(
                 'slot', mp.slot, 'userId', mp.user_id, 'name', mp.display_name,
                 'isAi', mp.is_ai, 'roundsWon', mp.rounds_won))
                 FROM match_players mp WHERE mp.match_id = m.id) AS players
         FROM matches m
        WHERE ($2::text IS NULL OR m.status = $2)
          AND ($3::text IS NULL OR m.mode = $3)
        ORDER BY m.created_at DESC LIMIT $1`,
      [limit, params.status ?? null, params.mode ?? null],
    );
    return ok(rows);
  });

  app.post('/api/admin/matches/:id/cancel', async (request) => {
    const admin = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const refunds = await cancelAndRefund(id, 'Cancelled by administrator');
    await audit(admin, request, 'MATCH_CANCEL', { type: 'match', id }, { refunded: refunds.length });
    return ok({ refunded: refunds.length });
  });

  app.get('/api/admin/matches/:id/events', async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const rows = await query(
      `SELECT id, round_no, user_id, type, payload, server_time
         FROM game_events WHERE match_id = $1 ORDER BY id LIMIT 500`,
      [id],
    );
    return ok(rows);
  });

  // ---------------------------------------------------------------- security

  app.get('/api/admin/suspicious', async (request) => {
    await requireAdmin(request);
    const params = request.query as { resolved?: string };
    const rows = await query(
      `SELECT s.*, u.username, u.telegram_id
         FROM suspicious_events s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.resolved = $1
        ORDER BY s.created_at DESC LIMIT 100`,
      [params.resolved === 'true'],
    );
    return ok(rows);
  });

  app.post('/api/admin/suspicious/:id/resolve', async (request) => {
    const admin = await requireAdmin(request);
    const { id } = request.params as { id: string };
    await queryOne('UPDATE suspicious_events SET resolved = TRUE WHERE id = $1', [id]);
    await audit(admin, request, 'SUSPICIOUS_RESOLVE', { type: 'suspicious_event', id });
    return ok({ resolved: true });
  });

  app.get('/api/admin/audit', async (request) => {
    await requireAdmin(request);
    const rows = await query(
      `SELECT a.*, u.username AS admin_username
         FROM admin_actions a JOIN users u ON u.id = a.admin_user_id
        ORDER BY a.created_at DESC LIMIT 200`,
    );
    return ok(rows);
  });

  // ---------------------------------------------------------------- settings

  app.get('/api/admin/settings', async (request) => {
    await requireAdmin(request);
    const settings = await getSettings();
    return ok({ settings, keys: Object.keys(settingsSchema.shape) });
  });

  app.put('/api/admin/settings', async (request) => {
    const admin = await requireAdmin(request);
    const body = settingSchema.safeParse(request.body);
    if (!body.success) throw errors.validation('key and value are required.');

    if (!(body.data.key in settingsSchema.shape)) {
      throw errors.validation(`Unknown setting: ${body.data.key}`);
    }

    try {
      await setSetting(body.data.key as SettingKey, body.data.value, admin.id);
    } catch (error) {
      throw errors.validation(error instanceof Error ? error.message : 'Invalid setting value.');
    }

    await audit(admin, request, 'SETTING_UPDATE', { type: 'setting', id: body.data.key }, {
      value: body.data.value,
    });

    return ok(await getSettings());
  });

  // ---------------------------------------------------------------- dev tools

  /**
   * Simulate an incoming deposit. Only works with the mock provider, so it can
   * never fabricate a credit against a real chain.
   */
  app.post('/api/admin/simulate-deposit', async (request) => {
    const admin = await requireAdmin(request);
    const provider = mockProvider();
    if (!provider) {
      throw errors.forbidden('Deposit simulation is only available with the mock TON provider.');
    }

    const body = z
      .object({ userId: z.string().uuid(), amountMicros: z.string().regex(/^\d+$/) })
      .safeParse(request.body);
    if (!body.success) throw errors.validation('userId and amountMicros are required.');

    const { depositMemoFor } = await import('../../modules/wallet/service.js');
    provider.injectDeposit({
      txHash: `sim-${Date.now()}-${body.data.userId.slice(0, 8)}`,
      fromAddress: 'simulated',
      toAddress: 'platform',
      amountMicros: BigInt(body.data.amountMicros),
      comment: depositMemoFor(body.data.userId),
      confirmations: 99,
      timestamp: new Date(),
    });

    await audit(admin, request, 'SIMULATE_DEPOSIT', { type: 'user', id: body.data.userId }, {
      amountMicros: body.data.amountMicros,
    });
    return ok({ queued: true, note: 'The deposit watcher will credit this on its next poll.' });
  });
}
