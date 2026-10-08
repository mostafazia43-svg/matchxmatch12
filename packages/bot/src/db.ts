/**
 * Bot database access.
 *
 * Read-mostly. The bot answers questions about a player and marks
 * notifications delivered; it never touches a balance, a match or a setting.
 * Money mutations belong to the backend, where the ledger and its constraints
 * live — a second writer would be a second place for a bug to create USDT.
 */

import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  application_name: 'clickbattle-bot',
  connectionTimeoutMillis: 5_000,
});

export async function closeDb(): Promise<void> {
  await pool.end().catch(() => undefined);
}

export async function linkChatId(telegramId: bigint, chatId: bigint): Promise<void> {
  await pool.query(
    `UPDATE telegram_accounts SET chat_id = $2 WHERE telegram_id = $1`,
    [telegramId.toString(), chatId.toString()],
  );
}

export interface WalletView {
  available: bigint;
  locked: bigint;
}

export async function walletFor(telegramId: bigint): Promise<WalletView | null> {
  const { rows } = await pool.query<{ available_micros: string; locked_micros: string }>(
    `SELECT w.available_micros, w.locked_micros
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE u.telegram_id = $1`,
    [telegramId.toString()],
  );
  const row = rows[0];
  if (!row) return null;
  return { available: BigInt(row.available_micros), locked: BigInt(row.locked_micros) };
}

export interface StatsView {
  level: number;
  xp: string;
  points: string;
  totalMatches: number;
  wins: number;
  losses: number;
  bestReactionMs: number | null;
  currentStreak: number;
  bestStreak: number;
  rank: number | null;
}

export async function playerStats(telegramId: bigint): Promise<StatsView | null> {
  const { rows } = await pool.query<{
    level: number;
    xp: string;
    points: string;
    total_matches: number;
    wins: number;
    losses: number;
    best_reaction_ms: number | null;
    current_streak: number;
    best_streak: number;
    rank: string | null;
  }>(
    `SELECT p.level, p.xp, p.points, p.total_matches, p.wins, p.losses,
            p.best_reaction_ms, p.current_streak, p.best_streak,
            (SELECT l.rank FROM leaderboard l WHERE l.user_id = u.id) AS rank
       FROM player_progress p JOIN users u ON u.id = p.user_id
      WHERE u.telegram_id = $1`,
    [telegramId.toString()],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    level: row.level,
    xp: row.xp,
    points: row.points,
    totalMatches: row.total_matches,
    wins: row.wins,
    losses: row.losses,
    bestReactionMs: row.best_reaction_ms,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    rank: row.rank === null ? null : Number(row.rank),
  };
}

export interface LeaderRow {
  displayName: string;
  level: number;
  points: string;
}

export async function topPlayers(limit = 10): Promise<LeaderRow[]> {
  const { rows } = await pool.query<{ display_name: string; level: number; points: string }>(
    `SELECT display_name, level, points FROM leaderboard ORDER BY rank LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    displayName: row.display_name,
    level: row.level,
    points: row.points,
  }));
}

export interface PendingNotification {
  id: string;
  chatId: bigint | null;
  text: string;
  markSent(): Promise<void>;
  markFailed(error: string, permanent: boolean): Promise<void>;
}

/**
 * Claim pending notifications.
 *
 * `FOR UPDATE SKIP LOCKED` lets several bot instances drain the queue
 * concurrently without any of them delivering the same message twice.
 */
export async function takePendingNotifications(limit = 20): Promise<PendingNotification[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      payload: { text?: string };
      chat_id: string | null;
    }>(
      `SELECT n.id, n.payload, t.chat_id
         FROM notifications n
         LEFT JOIN telegram_accounts t ON t.user_id = n.user_id
        WHERE n.status = 'PENDING' AND n.attempts < 5
        ORDER BY n.created_at
        LIMIT $1
        FOR UPDATE OF n SKIP LOCKED`,
      [limit],
    );

    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE notifications SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    }
    await client.query('COMMIT');

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id ? BigInt(row.chat_id) : null,
      text: row.payload.text ?? '',
      async markSent() {
        await pool.query(
          `UPDATE notifications SET status = 'SENT', sent_at = now() WHERE id = $1`,
          [row.id],
        );
      },
      async markFailed(error: string, permanent: boolean) {
        await pool.query(
          `UPDATE notifications
              SET status = CASE WHEN $3 OR attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
                  error = $2
            WHERE id = $1`,
          [row.id, error.slice(0, 500), permanent],
        );
      },
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
