import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Same minimal .env loader as the backend — the bot shares the project's .env. */
function loadDotEnv(): void {
  for (const candidate of ['.env', '../../.env', '../../../.env']) {
    try {
      const text = readFileSync(resolve(process.cwd(), candidate), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
        if (!match) continue;
        const key = match[1]!;
        if (process.env[key] !== undefined) continue;
        let value = match[2] ?? '';
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
      return;
    } catch {
      // try the next candidate
    }
  }
}

loadDotEnv();

const csv = (value: string): string[] => value.split(',').map((p) => p.trim()).filter(Boolean);

export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN ?? '',
  BOT_USERNAME: process.env.BOT_USERNAME ?? 'ClickspeedUSDTBot',
  BOT_WEBHOOK_URL: process.env.BOT_WEBHOOK_URL ?? '',
  BOT_WEBHOOK_SECRET: process.env.BOT_WEBHOOK_SECRET ?? '',
  MINI_APP_URL: process.env.MINI_APP_URL ?? '',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgres://clickbattle:clickbattle@localhost:5432/clickbattle',
  DATABASE_SSL: (process.env.DATABASE_SSL ?? 'false').toLowerCase() === 'true',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  adminTelegramIds: csv(process.env.ADMIN_TELEGRAM_IDS ?? '').map((id) => BigInt(id)),
} as const;
