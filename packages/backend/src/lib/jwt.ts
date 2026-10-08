/**
 * Session tokens.
 *
 * HS256 JWTs carrying a `jti` that is also a row in `sessions`, so a token can
 * be revoked server-side (block a user, force a logout) instead of remaining
 * valid until it expires. The token itself carries no balance and no
 * permissions — admin status is re-derived from the database on every request,
 * so promoting or demoting an admin takes effect immediately.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';
import { errors } from './errors.js';
import { randomToken } from './ids.js';

const ISSUER = 'clickbattle';
const AUDIENCE = 'clickbattle-miniapp';

let cachedKey: Uint8Array | null = null;

function key(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (env.isProduction) throw new Error('JWT_SECRET must be at least 32 characters in production.');
    // Development convenience only — a restart invalidates every session,
    // which is the correct behaviour for a throwaway secret.
    cachedKey = new TextEncoder().encode(randomToken(48));
    return cachedKey;
  }
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  tg: string;
  jti: string;
}

export interface IssuedToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

export async function issueToken(userId: string, telegramId: bigint): Promise<IssuedToken> {
  const jti = randomToken(24);
  const expiresAt = new Date(Date.now() + env.JWT_TTL_SECONDS * 1000);

  const token = await new SignJWT({ tg: telegramId.toString() })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());

  return { token, jti, expiresAt };
}

export async function verifyToken(token: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      throw errors.unauthorized('Malformed session token.');
    }
    return payload as SessionClaims;
  } catch {
    throw errors.unauthorized('Session expired or invalid. Reopen the app.');
  }
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
