/**
 * Gameplay, profile, leaderboard and history routes.
 *
 * These endpoints are for state the client needs on load or refresh. All
 * in-match action happens over the WebSocket — a REST call cannot influence a
 * live round.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GameMode, LeaderboardEntry } from '@cb/shared';
import { getSettings } from '../../config/settings.js';
import { query } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import * as engine from '../../modules/game/engine.js';
import { activeMatchFor, matchView } from '../../modules/game/store.js';
import * as matchmaking from '../../modules/matchmaking/service.js';
import { assertMembershipFor, checkMembership, myRank, progressFor } from '../../modules/users/service.js';
import { walletSummary } from '../../modules/wallet/service.js';
import { ok, rateLimit, requireAuth, requireOperational } from '../plugins.js';

const joinSchema = z.object({
  mode: z.enum(['FREE', 'PAID', 'DEMO']),
  entryMicros: z.string().regex(/^\d{1,19}$/).optional(),
});

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- profile

  app.get('/api/me', async (request) => {
    const user = await requireAuth(request);
    const [progress, wallet, rank, membership] = await Promise.all([
      progressFor(user.id),
      walletSummary(user.id),
      myRank(user.id),
      checkMembership(user.telegramId, user.id),
    ]);

    return ok({
      user: {
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        level: progress.level,
        isAdmin: user.isAdmin,
      },
      progress,
      wallet,
      rank,
      membership: {
        required: membership.required,
        isMember: membership.isMember,
        inviteUrl: membership.inviteUrl,
      },
      activeMatchId: engine.liveMatchFor(user.id) ?? (await activeMatchFor(user.id)),
    });
  });

  // ---------------------------------------------------------------- matchmaking

  app.post(
    '/api/matchmaking/join',
    { preHandler: rateLimit({ limit: 30, windowMs: 60_000, scope: 'queue' }) },
    async (request) => {
      const user = await requireAuth(request);
      await requireOperational(request);

      const body = joinSchema.safeParse(request.body);
      if (!body.success) throw errors.validation('mode is required.');

      const mode = body.data.mode as GameMode;
      await assertMembershipFor(user.telegramId, user.id, mode);

      const progress = await progressFor(user.id);
      const result = await matchmaking.join({
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.photoUrl,
        level: progress.level,
        mode,
        entryMicros: body.data.entryMicros ? BigInt(body.data.entryMicros) : 0n,
      });

      return ok(result);
    },
  );

  app.post('/api/matchmaking/leave', async (request) => {
    const user = await requireAuth(request);
    const left = await matchmaking.leave(user.id);
    return ok({ left });
  });

  app.post('/api/matchmaking/accept-ai', async (request) => {
    const user = await requireAuth(request);
    const matchId = await matchmaking.acceptAiOffer(user.id);
    return ok({ matchId });
  });

  app.get('/api/matchmaking/status', async (request) => {
    const user = await requireAuth(request);
    const settings = await getSettings();
    return ok({
      queued: matchmaking.isQueued(user.id),
      activeMatchId: engine.liveMatchFor(user.id) ?? (await activeMatchFor(user.id)),
      timeoutMs: settings['matchmaking.timeout_ms'],
    });
  });

  // ---------------------------------------------------------------- matches

  app.get('/api/matches/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = request.params as { id: string };
    const view = await matchView(id, user.id);
    if (!view) throw errors.matchNotFound();

    // A match is visible to its players; anyone else sees only a finished one.
    const isParticipant = view.players.some((p) => p.userId === user.id);
    if (!isParticipant && view.status !== 'MATCH_FINISHED') throw errors.notAParticipant();

    return ok(view);
  });

  app.get('/api/matches', async (request) => {
    const user = await requireAuth(request);
    const params = request.query as { limit?: string; mode?: string };
    const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);

    const rows = await query<{
      id: string;
      short_code: string;
      mode: string;
      status: string;
      entry_micros: string;
      prize_micros: string;
      winner_slot: number | null;
      my_slot: number;
      my_rounds: number;
      opponent_name: string;
      opponent_avatar: string | null;
      opponent_is_ai: boolean;
      opponent_rounds: number;
      created_at: Date;
      finished_at: Date | null;
    }>(
      `
      SELECT m.id, m.short_code, m.mode, m.status, m.entry_micros, m.prize_micros, m.winner_slot,
             me.slot AS my_slot, me.rounds_won AS my_rounds,
             opp.display_name AS opponent_name, opp.avatar_url AS opponent_avatar,
             opp.is_ai AS opponent_is_ai, opp.rounds_won AS opponent_rounds,
             m.created_at, m.finished_at
        FROM match_players me
        JOIN matches m       ON m.id = me.match_id
        LEFT JOIN match_players opp ON opp.match_id = m.id AND opp.slot <> me.slot
       WHERE me.user_id = $1
         AND ($3::text IS NULL OR m.mode = $3)
       ORDER BY m.created_at DESC
       LIMIT $2
      `,
      [user.id, limit, params.mode ?? null],
    );

    return ok(
      rows.map((row) => ({
        id: row.id,
        shortCode: row.short_code,
        mode: row.mode,
        status: row.status,
        entryMicros: row.entry_micros,
        prizeMicros: row.prize_micros,
        won: row.winner_slot !== null && row.winner_slot === row.my_slot,
        score: { you: row.my_rounds, opponent: row.opponent_rounds ?? 0 },
        opponent: {
          displayName: row.opponent_name ?? 'Unknown',
          avatarUrl: row.opponent_avatar,
          isAi: row.opponent_is_ai ?? false,
        },
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
      })),
    );
  });

  // ---------------------------------------------------------------- leaderboard

  app.get('/api/leaderboard', async (request) => {
    const user = await requireAuth(request);
    const params = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);

    const rows = await query<{
      rank: string;
      user_id: string;
      display_name: string;
      photo_url: string | null;
      level: number;
      xp: string;
      points: string;
      wins: number;
      losses: number;
      win_rate: string;
      best_reaction_ms: number | null;
    }>(
      `SELECT rank, user_id, display_name, photo_url, level, xp, points,
              wins, losses, win_rate, best_reaction_ms
         FROM leaderboard
        ORDER BY rank
        LIMIT $1`,
      [limit],
    );

    const toEntry = (row: (typeof rows)[number]): LeaderboardEntry => ({
      rank: Number(row.rank),
      userId: row.user_id,
      displayName: row.display_name,
      photoUrl: row.photo_url,
      level: row.level,
      xp: row.xp,
      points: row.points,
      wins: row.wins,
      losses: row.losses,
      winRate: Number(row.win_rate),
      bestReactionMs: row.best_reaction_ms,
      isSelf: row.user_id === user.id,
    });

    const top = rows.map(toEntry);

    // The player's own row, even when they are far outside the top N.
    let me = top.find((entry) => entry.isSelf) ?? null;
    if (!me) {
      const mine = await query<(typeof rows)[number]>(
        `SELECT rank, user_id, display_name, photo_url, level, xp, points,
                wins, losses, win_rate, best_reaction_ms
           FROM leaderboard WHERE user_id = $1`,
        [user.id],
      );
      me = mine[0] ? toEntry(mine[0]) : null;
    }

    return ok({ entries: top, me });
  });
}
