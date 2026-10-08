import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings, publicConfig } from '../../config/settings.js';
import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import {
  authenticateDev,
  authenticateWithInitData,
  revokeSession,
} from '../../modules/auth/service.js';
import { ok, rateLimit, requireAuth } from '../plugins.js';

const loginSchema = z.object({ initData: z.string().min(1).max(8192) });
const devLoginSchema = z.object({
  telegramId: z.string().regex(/^\d{1,19}$/),
  name: z.string().min(1).max(40),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Exchange Telegram initData for a session token.
   * Rate limited by IP: this is the one unauthenticated write endpoint, so it
   * is also the one an attacker would hammer to brute-force a signature.
   */
  app.post(
    '/api/auth/telegram',
    { preHandler: rateLimit({ limit: 20, windowMs: 60_000, scope: 'auth' }) },
    async (request) => {
      const body = loginSchema.safeParse(request.body);
      if (!body.success) throw errors.validation('initData is required.');

      const result = await authenticateWithInitData(body.data.initData, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      const settings = await getSettings();
      return ok({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        isNewUser: result.isNewUser,
        user: {
          id: result.user.id,
          telegramId: result.user.telegramId.toString(),
          username: result.user.username,
          displayName: result.user.displayName,
          photoUrl: result.user.photoUrl,
          level: result.user.level,
          isAdmin: result.user.isAdmin,
        },
        config: publicConfig(settings),
      });
    },
  );

  /** Local development only — refuses to exist unless ALLOW_DEV_AUTH is set. */
  app.post(
    '/api/auth/dev',
    { preHandler: rateLimit({ limit: 30, windowMs: 60_000, scope: 'auth-dev' }) },
    async (request) => {
      if (!env.ALLOW_DEV_AUTH || env.isProduction) {
        throw errors.forbidden('Development authentication is disabled.');
      }
      const body = devLoginSchema.safeParse(request.body);
      if (!body.success) throw errors.validation('telegramId and name are required.');

      const result = await authenticateDev(BigInt(body.data.telegramId), body.data.name);
      const settings = await getSettings();
      return ok({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        isNewUser: result.isNewUser,
        user: {
          id: result.user.id,
          telegramId: result.user.telegramId.toString(),
          username: result.user.username,
          displayName: result.user.displayName,
          photoUrl: result.user.photoUrl,
          level: result.user.level,
          isAdmin: result.user.isAdmin,
        },
        config: publicConfig(settings),
      });
    },
  );

  app.post('/api/auth/logout', async (request) => {
    await requireAuth(request);
    if (request.sessionJti) await revokeSession(request.sessionJti);
    return ok({ loggedOut: true });
  });

  /** Non-secret configuration, readable without a session so the app can boot. */
  app.get('/api/config', async () => {
    const settings = await getSettings();
    return ok(publicConfig(settings));
  });
}
