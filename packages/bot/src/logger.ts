import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'clickbattle-bot' },
  // The bot token appears in Telegram API URLs; never let one reach a log sink.
  redact: { paths: ['BOT_TOKEN', 'token', '*.token'], censor: '[redacted]' },
  transport:
    env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
