/**
 * Cross-cutting HTTP concerns: auth guard, rate limiting, response envelope,
 * error mapping and security headers.
 *
 * Keeping these in one place means a new route cannot accidentally opt out of
 * authentication by forgetting a decorator — `requireAuth` is explicit on
 * every protected route, and `requireAdmin` re-checks admin status against the
 * database rather than trusting a claim in the token.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, type ApiResponse } from '@cb/shared';
import { env } from '../config/env.js';
import { getSettings } from '../config/settings.js';
import { AppError, errors, isAppError } from '../lib/errors.js';
import { bearerFrom, verifyToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { consume } from '../lib/ratelimit.js';
import { resolveSession, touchLastSeen, type AuthedUser } from '../modules/auth/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    sessionJti?: string;
  }
}

export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function fail(error: AppError): ApiResponse<never> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.exposeMessage ? error.message : 'Something went wrong on our side.',
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

/** Authenticate. Throws rather than returning, so a route body cannot proceed unauthenticated. */
export async function requireAuth(request: FastifyRequest): Promise<AuthedUser> {
  if (request.user) return request.user;

  const token = bearerFrom(request.headers.authorization);
  if (!token) throw errors.unauthorized();

  const claims = await verifyToken(token);
  const user = await resolveSession(claims.sub, claims.jti);
  if (!user) throw errors.unauthorized('Your session has ended. Reopen the app.');
  if (user.isBlocked) throw errors.blocked(user.blockedReason);

  request.user = user;
  request.sessionJti = claims.jti;
  void touchLastSeen(user.id);
  return user;
}

/**
 * Admin authorization.
 *
 * Derived from ADMIN_TELEGRAM_IDS at request time. Nothing in the token grants
 * it, so revoking an admin takes effect on the next request rather than when
 * their session happens to expire.
 */
export async function requireAdmin(request: FastifyRequest): Promise<AuthedUser> {
  const user = await requireAuth(request);
  if (!user.isAdmin) {
    logger.warn({ userId: user.id, path: request.url }, 'non-admin attempted an admin route');
    throw errors.forbidden('Administrator access required.');
  }
  return user;
}

/** Block gameplay routes while maintenance mode is on; admins are exempt. */
export async function requireOperational(request: FastifyRequest): Promise<void> {
  const settings = await getSettings();
  if (!settings['ops.maintenance_mode']) return;
  if (request.user?.isAdmin) return;
  throw errors.maintenance(settings['ops.maintenance_message']);
}

export function rateLimit(options: { limit: number; windowMs: number; scope: string }) {
  return async function limiter(request: FastifyRequest): Promise<void> {
    const identity = request.user?.id ?? request.ip;
    const result = await consume(`${options.scope}:${identity}`, options.limit, options.windowMs);
    if (!result.allowed) throw errors.rateLimited(result.retryAfterMs);
  };
}

export async function registerErrorHandling(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(fail(errors.notFound(`No route for ${request.method} ${request.url}`)));
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (isAppError(error)) {
      if (error.statusCode >= 500) logger.error({ err: error, path: request.url }, 'app error');
      void reply.status(error.statusCode).send(fail(error));
      return;
    }

    // Fastify's own validation errors carry a statusCode.
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      const message = error instanceof Error ? error.message : 'Invalid request.';
      void reply.status(status).send(fail(new AppError(ErrorCode.VALIDATION, message, status)));
      return;
    }

    // Unknown failure: log everything, expose nothing.
    logger.error({ err: error, path: request.url }, 'unhandled route error');
    void reply.status(500).send(fail(errors.internal()));
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'ALLOWALL'); // the Mini App runs inside Telegram's webview
    if (env.isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}
