/**
 * Authentication service.
 *
 * There is no registration, no password and no email — a player exists because
 * Telegram vouched for them. First contact provisions the whole account
 * (user + telegram profile + wallet + progress) in one transaction, so a
 * player can never end up with, say, a user row but no wallet row.
 */

import { env, isAdminTelegramId } from '../../config/env.js';
import { queryOne, withTransaction, type Tx } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { issueToken } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { InitDataError, verifyInitData, type TelegramUser } from './telegram.js';

export interface AuthedUser {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  displayName: string;
  photoUrl: string | null;
  level: number;
  isAdmin: boolean;
  isBlocked: boolean;
  blockedReason: string | null;
}

export interface AuthResult {
  token: string;
  expiresAt: Date;
  user: AuthedUser;
  isNewUser: boolean;
}

export function displayNameFor(user: {
  username: string | null;
  firstName: string;
  lastName: string | null;
}): string {
  if (user.username) return user.username;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || 'Player';
}

interface UserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
  photo_url: string | null;
  is_blocked: boolean;
  blocked_reason: string | null;
  level: number | null;
}

function toAuthedUser(row: UserRow): AuthedUser {
  const telegramId = BigInt(row.telegram_id);
  return {
    id: row.id,
    telegramId,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: displayNameFor({
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
    }),
    photoUrl: row.photo_url,
    level: row.level ?? 1,
    isAdmin: isAdminTelegramId(telegramId),
    isBlocked: row.is_blocked,
    blockedReason: row.blocked_reason,
  };
}

/**
 * Create or refresh the account behind a verified Telegram identity.
 * Idempotent: repeated logins update the profile snapshot and nothing else.
 */
export async function provisionUser(
  tx: Tx,
  tg: TelegramUser,
  rawProfile: Record<string, string>,
): Promise<{ row: UserRow; isNew: boolean }> {
  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM users WHERE telegram_id = $1',
    [tg.id.toString()],
  );
  const isNew = existing.rowCount === 0;

  const upsert = await tx.query<UserRow>(
    `
    INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, language_code, is_premium)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username      = EXCLUDED.username,
      first_name    = EXCLUDED.first_name,
      last_name     = EXCLUDED.last_name,
      photo_url     = EXCLUDED.photo_url,
      language_code = EXCLUDED.language_code,
      is_premium    = EXCLUDED.is_premium,
      updated_at    = now(),
      last_seen_at  = now()
    RETURNING id, telegram_id, username, first_name, last_name, photo_url,
              is_blocked, blocked_reason, NULL::int AS level
    `,
    [
      tg.id.toString(),
      tg.username,
      tg.firstName,
      tg.lastName,
      tg.photoUrl,
      tg.languageCode,
      tg.isPremium,
    ],
  );

  const row = upsert.rows[0];
  if (!row) throw errors.internal('Failed to provision the account.');

  await tx.query(
    `
    INSERT INTO telegram_accounts (user_id, telegram_id, raw_profile, auth_count, last_auth_at)
    VALUES ($1, $2, $3::jsonb, 1, now())
    ON CONFLICT (user_id) DO UPDATE SET
      raw_profile  = EXCLUDED.raw_profile,
      auth_count   = telegram_accounts.auth_count + 1,
      last_auth_at = now()
    `,
    [row.id, tg.id.toString(), JSON.stringify(rawProfile)],
  );

  // A player without a wallet row or a progress row is an invalid state that
  // would surface much later as a null-balance crash. Create them up front.
  await tx.query(
    'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [row.id],
  );
  await tx.query(
    'INSERT INTO player_progress (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [row.id],
  );

  const withLevel = await tx.query<{ level: number }>(
    'SELECT level FROM player_progress WHERE user_id = $1',
    [row.id],
  );
  row.level = withLevel.rows[0]?.level ?? 1;

  return { row, isNew };
}

export async function authenticateWithInitData(
  initData: string,
  context: { ip?: string; userAgent?: string } = {},
): Promise<AuthResult> {
  let verified;
  try {
    verified = verifyInitData(initData, {
      botToken: env.BOT_TOKEN,
      maxAgeSeconds: env.AUTH_INITDATA_MAX_AGE_SECONDS,
    });
  } catch (error) {
    if (error instanceof InitDataError) {
      logger.warn({ reason: error.reason }, 'rejected Telegram initData');
      if (error.reason === 'NO_BOT_TOKEN') {
        throw errors.internal('Telegram authentication is not configured on this server.');
      }
      throw errors.unauthorized(
        error.reason === 'EXPIRED'
          ? 'Your session expired. Please reopen the app from Telegram.'
          : 'Telegram authentication failed.',
      );
    }
    throw error;
  }

  return withTransaction(async (tx) => {
    const { row, isNew } = await provisionUser(tx, verified.user, verified.raw);
    const user = toAuthedUser(row);

    if (user.isBlocked) throw errors.blocked(user.blockedReason);

    const { token, jti, expiresAt } = await issueToken(user.id, user.telegramId);
    await tx.query(
      `INSERT INTO sessions (user_id, jti, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, jti, expiresAt, context.ip ?? null, context.userAgent?.slice(0, 400) ?? null],
    );

    logger.info({ userId: user.id, isNew }, 'telegram auth ok');
    return { token, expiresAt, user, isNewUser: isNew };
  });
}

/**
 * Development-only login that skips Telegram entirely.
 * Guarded by ALLOW_DEV_AUTH, which `assertProductionSafety()` refuses to allow
 * in production — without that guard this would be a total auth bypass.
 */
export async function authenticateDev(telegramId: bigint, name: string): Promise<AuthResult> {
  if (!env.ALLOW_DEV_AUTH || env.isProduction) {
    throw errors.forbidden('Development authentication is disabled.');
  }

  return withTransaction(async (tx) => {
    const { row, isNew } = await provisionUser(
      tx,
      {
        id: telegramId,
        firstName: name,
        lastName: null,
        username: name.toLowerCase().replace(/[^a-z0-9_]/g, '') || null,
        languageCode: 'en',
        isPremium: false,
        photoUrl: null,
        allowsWriteToPm: true,
      },
      { dev: 'true' },
    );
    const user = toAuthedUser(row);
    if (user.isBlocked) throw errors.blocked(user.blockedReason);

    const { token, jti, expiresAt } = await issueToken(user.id, user.telegramId);
    await tx.query(
      'INSERT INTO sessions (user_id, jti, expires_at, ip) VALUES ($1, $2, $3, $4)',
      [user.id, jti, expiresAt, 'dev'],
    );
    return { token, expiresAt, user, isNewUser: isNew };
  });
}

/** Resolve the live account behind a session token. Returns null if unusable. */
export async function resolveSession(userId: string, jti: string): Promise<AuthedUser | null> {
  const row = await queryOne<UserRow & { revoked_at: Date | null }>(
    `
    SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name, u.photo_url,
           u.is_blocked, u.blocked_reason, p.level, s.revoked_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN player_progress p ON p.user_id = u.id
    WHERE s.jti = $1 AND s.user_id = $2 AND s.expires_at > now()
    `,
    [jti, userId],
  );

  if (!row || row.revoked_at) return null;
  return toAuthedUser(row);
}

export async function revokeSession(jti: string): Promise<void> {
  await queryOne('UPDATE sessions SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL', [jti]);
}

export async function revokeAllSessions(userId: string, tx?: Tx): Promise<void> {
  const sql = 'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL';
  if (tx) await tx.query(sql, [userId]);
  else await queryOne(sql, [userId]);
}

export async function touchLastSeen(userId: string): Promise<void> {
  await queryOne('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]).catch(() => undefined);
}
