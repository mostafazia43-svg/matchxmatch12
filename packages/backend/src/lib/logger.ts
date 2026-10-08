import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging.
 *
 * `redact` is not cosmetic — bot tokens, initData and Authorization headers
 * pass through request logging, and a leaked BOT_TOKEN in a log aggregator is
 * a full account compromise.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'initData',
      '*.initData',
      'token',
      '*.token',
      'BOT_TOKEN',
      'JWT_SECRET',
      'TON_PAYOUT_MNEMONIC',
      'mnemonic',
      'seed',
    ],
    censor: '[redacted]',
  },
  base: { service: 'clickbattle' },
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

export type Logger = typeof logger;

export const child = (bindings: Record<string, unknown>) => logger.child(bindings);
