/**
 * Bootstrap.
 *
 * Order matters and is not arbitrary:
 *   1. Refuse to start with an unsafe production configuration.
 *   2. Migrate, so the schema the code expects actually exists.
 *   3. Recover from any previous crash BEFORE accepting traffic — a player
 *      must not be able to queue while their old locked stake is still held.
 *   4. Only then open the HTTP and WebSocket listeners.
 *
 * Shutdown reverses it: stop accepting, drain live matches (refunding), then
 * close the pool. Nothing is left holding money.
 */

import { assertProductionSafety, env } from './config/env.js';
import { getSettings } from './config/settings.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/ratelimit.js';
import * as engine from './modules/game/engine.js';
import { recoverFromRestart } from './modules/game/recovery.js';
import * as matchmaking from './modules/matchmaking/service.js';
import { startDepositWatcher, stopDepositWatcher } from './modules/payments/watcher.js';
import { tonProvider } from './modules/payments/provider.js';
import { attachGateway } from './realtime/gateway.js';
import { closeAll } from './realtime/hub.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  assertProductionSafety();

  logger.info(
    { env: env.NODE_ENV, provider: env.TON_PROVIDER, network: env.TON_NETWORK },
    'starting Click Battle backend',
  );

  const { applied, skipped } = await runMigrations();
  logger.info({ applied: applied.length, skipped }, 'database ready');

  await getSettings();
  await recoverFromRestart();

  const app = await buildServer();
  await app.listen({ port: env.PORT, host: env.HOST });

  const gateway = attachGateway(app.server);
  startDepositWatcher();

  logger.info(
    { port: env.PORT, provider: tonProvider().name },
    `Click Battle listening on http://${env.HOST}:${env.PORT}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    stopDepositWatcher();
    // Refund everything in flight before the process can disappear.
    await matchmaking.drain().catch((error) => logger.error({ err: error }, 'queue drain failed'));
    await engine
      .drain('The server is restarting. Your entry has been returned.')
      .catch((error) => logger.error({ err: error }, 'match drain failed'));

    closeAll();
    gateway.close();
    await app.close().catch(() => undefined);
    await closeRedis();
    await closePool().catch(() => undefined);

    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    // A corrupted process must not keep running a money game.
    logger.fatal({ err: error }, 'uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  // The overwhelmingly common first-run failure is "Postgres isn't running".
  // A raw AggregateError stack helps nobody diagnose that.
  const message = String((error as { message?: string })?.message ?? error);
  const code = String((error as { code?: string })?.code ?? '');
  const refused =
    code === 'ECONNREFUSED' ||
    message.includes('ECONNREFUSED') ||
    (error instanceof AggregateError &&
      error.errors.some((e) => String((e as { code?: string })?.code) === 'ECONNREFUSED'));

  if (refused) {
    logger.fatal(
      `Cannot reach PostgreSQL at ${env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}\n` +
        '  Start it with:  docker compose up -d postgres\n' +
        '  Or point DATABASE_URL at a running instance.',
    );
  } else {
    logger.fatal({ err: error }, 'failed to start');
  }
  process.exit(1);
});
