import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { getSettings } from './config/settings.js';
import { healthcheck } from './db/pool.js';
import { logger } from './lib/logger.js';
import { adminRoutes } from './http/routes/admin.js';
import { authRoutes } from './http/routes/auth.js';
import { gameRoutes } from './http/routes/game.js';
import { walletRoutes } from './http/routes/wallet.js';
import { ok, rateLimit, registerErrorHandling } from './http/plugins.js';
import { tonProvider } from './modules/payments/provider.js';
import { connectionCount, onlineUserCount } from './realtime/hub.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin(origin, callback) {
      // Non-browser callers (the bot, health checks) send no Origin.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      // Telegram serves Mini Apps from its own origins in some clients.
      if (/^https:\/\/([a-z0-9-]+\.)*telegram\.org$/.test(origin)) return callback(null, true);
      logger.warn({ origin }, 'blocked a cross-origin request');
      return callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await registerErrorHandling(app);

  // A blanket limiter under the per-route ones; catches broad scraping.
  app.addHook(
    'onRequest',
    rateLimit({
      limit: env.RATE_LIMIT_MAX_REQUESTS,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      scope: 'global',
    }),
  );

  app.get('/health', async (_request, reply) => {
    const dbUp = await healthcheck();
    if (!dbUp) {
      // Never report healthy without a database — gameplay would advance
      // state it cannot persist.
      return reply.status(503).send({ ok: false, error: { code: 'DB_DOWN', message: 'database unavailable' } });
    }
    return ok({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      onlineUsers: onlineUserCount(),
      connections: connectionCount(),
      provider: tonProvider().name,
    });
  });

  app.get('/ready', async () => {
    const settings = await getSettings();
    return ok({ ready: true, maintenance: settings['ops.maintenance_mode'] });
  });

  await app.register(authRoutes);
  await app.register(gameRoutes);
  await app.register(walletRoutes);
  await app.register(adminRoutes);

  return app;
}
