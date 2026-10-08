/**
 * Telegram WebApp initData validation.
 *
 * This is the trust boundary of the entire product. Everything downstream —
 * identity, balance, prizes — rests on the claim that this string really came
 * from Telegram and really describes this user. Consequences of the rules here:
 *
 *   - The hash is verified with the bot token. A client cannot forge it without
 *     the token, and the token never leaves the server.
 *   - The comparison is timing-safe. A byte-by-byte early return would leak the
 *     expected hash to a patient attacker.
 *   - `auth_date` is age-checked, so a captured initData string cannot be
 *     replayed forever.
 *   - The `user` field is read ONLY from the verified payload, never from a
 *     separate request body field.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface TelegramUser {
  id: bigint;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  isPremium: boolean;
  photoUrl: string | null;
  allowsWriteToPm: boolean;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: Date;
  queryId: string | null;
  startParam: string | null;
  chatInstance: string | null;
  raw: Record<string, string>;
}

export type InitDataFailure =
  | 'MALFORMED'
  | 'MISSING_HASH'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'MISSING_USER'
  | 'NO_BOT_TOKEN';

export class InitDataError extends Error {
  constructor(readonly reason: InitDataFailure, message: string) {
    super(message);
    this.name = 'InitDataError';
  }
}

const userSchema = z.object({
  id: z.number().or(z.string()),
  first_name: z.string().default(''),
  last_name: z.string().nullish(),
  username: z.string().nullish(),
  language_code: z.string().nullish(),
  is_premium: z.boolean().nullish(),
  photo_url: z.string().nullish(),
  allows_write_to_pm: z.boolean().nullish(),
});

/**
 * Derive Telegram's signing key. Note the inversion that trips people up:
 * the literal string "WebAppData" is the HMAC *key* and the bot token is the
 * *message*, not the other way round.
 */
function secretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface VerifyOptions {
  botToken: string;
  /** Reject initData older than this. */
  maxAgeSeconds: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
}

export function verifyInitData(initData: string, options: VerifyOptions): VerifiedInitData {
  if (!options.botToken) {
    throw new InitDataError('NO_BOT_TOKEN', 'BOT_TOKEN is not configured; cannot verify Telegram auth.');
  }
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 8192) {
    throw new InitDataError('MALFORMED', 'initData is missing or implausibly large.');
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    throw new InitDataError('MALFORMED', 'initData is not a valid query string.');
  }

  const hash = params.get('hash');
  if (!hash) throw new InitDataError('MISSING_HASH', 'initData has no hash.');

  // Data-check-string: every field except `hash`, as "key=value", sorted by key,
  // joined with newlines. `signature` (third-party validation) stays included —
  // Telegram computes the bot-token hash over it too.
  const entries: string[] = [];
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    raw[key] = value;
    if (key === 'hash') continue;
    entries.push(`${key}=${value}`);
  }
  entries.sort();

  const expected = createHmac('sha256', secretKey(options.botToken))
    .update(entries.join('\n'))
    .digest('hex');

  if (!safeEquals(expected, hash)) {
    throw new InitDataError('BAD_SIGNATURE', 'initData signature does not match.');
  }

  const authDateRaw = params.get('auth_date');
  const authSeconds = Number(authDateRaw);
  if (!authDateRaw || !Number.isFinite(authSeconds)) {
    throw new InitDataError('MALFORMED', 'initData has no usable auth_date.');
  }
  const nowMs = (options.now ?? Date.now)();
  const ageSeconds = nowMs / 1000 - authSeconds;
  // A small negative age is normal clock skew; a large one is a forged future date.
  if (ageSeconds > options.maxAgeSeconds || ageSeconds < -300) {
    throw new InitDataError('EXPIRED', 'initData has expired. Reopen the app.');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new InitDataError('MISSING_USER', 'initData contains no user.');

  let parsedUser: z.infer<typeof userSchema>;
  try {
    parsedUser = userSchema.parse(JSON.parse(userRaw));
  } catch {
    throw new InitDataError('MISSING_USER', 'initData user payload is unreadable.');
  }

  return {
    user: {
      id: BigInt(parsedUser.id),
      firstName: parsedUser.first_name || 'Player',
      lastName: parsedUser.last_name ?? null,
      username: parsedUser.username ?? null,
      languageCode: parsedUser.language_code ?? null,
      isPremium: parsedUser.is_premium ?? false,
      photoUrl: parsedUser.photo_url ?? null,
      allowsWriteToPm: parsedUser.allows_write_to_pm ?? false,
    },
    authDate: new Date(authSeconds * 1000),
    queryId: params.get('query_id'),
    startParam: params.get('start_param'),
    chatInstance: params.get('chat_instance'),
    raw,
  };
}

/**
 * Build a valid initData string. Test-only helper, exported so the auth tests
 * exercise the real verifier rather than a mock of it.
 */
export function signInitDataForTest(
  botToken: string,
  user: Record<string, unknown>,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...extra,
  });
  const entries = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const hash = createHmac('sha256', secretKey(botToken)).update(entries.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
