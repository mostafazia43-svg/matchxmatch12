/**
 * Environment configuration.
 *
 * Parsed once at boot and validated hard: a misconfigured secret should stop
 * the process, not surface later as a silent auth bypass. Nothing in here is
 * ever sent to the frontend — `publicConfig()` in `settings.ts` is the only
 * thing the client sees.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Minimal .env loader — avoids a dependency for a dozen lines of parsing. */
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
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
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

const csv = (value: string): string[] =>
  value.split(',').map((part) => part.trim()).filter(Boolean);

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === 'true' || v === '1')
  .pipe(z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  BOT_TOKEN: z.string().default(''),
  BOT_USERNAME: z.string().default('ClickspeedUSDTBot'),
  ADMIN_TELEGRAM_IDS: z.string().default(''),
  MINI_APP_URL: z.string().default(''),
  BOT_WEBHOOK_URL: z.string().default(''),
  BOT_WEBHOOK_SECRET: z.string().default(''),

  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_URL: z.string().default('http://localhost:8080'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  JWT_SECRET: z.string().default(''),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  AUTH_INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86_400),
  ALLOW_DEV_AUTH: bool.default('false'),
  DEV_AUTH_SECRET: z.string().default(''),

  DATABASE_URL: z.string().default('postgres://clickbattle:clickbattle@localhost:5432/clickbattle'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_SSL: bool.default('false'),

  REDIS_URL: z.string().default(''),

  PLATFORM_WALLET_ADDRESS: z.string().default(''),
  TON_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  USDT_JETTON_MASTER: z.string().default(''),
  USDT_DECIMALS: z.coerce.number().int().default(6),
  TON_PROVIDER: z.enum(['mock', 'tonapi']).default('mock'),
  TONAPI_BASE_URL: z.string().default('https://tonapi.io'),
  TONAPI_KEY: z.string().default(''),
  DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
  TON_PAYOUT_ENABLED: bool.default('false'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(180),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(3),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: csv(raw.CORS_ORIGINS),
  adminTelegramIds: csv(raw.ADMIN_TELEGRAM_IDS).map((id) => BigInt(id)),
} as const;

export type Env = typeof env;

/**
 * Fail fast on anything that would be dangerous in production.
 * Called from the bootstrap so tests can import this module freely.
 */
export function assertProductionSafety(): void {
  if (!env.isProduction) return;
  const problems: string[] = [];

  if (!env.BOT_TOKEN) problems.push('BOT_TOKEN is required — Telegram auth cannot be verified without it.');
  if (env.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be at least 32 characters.');
  if (env.JWT_SECRET.startsWith('CHANGE_ME')) problems.push('JWT_SECRET is still the template placeholder.');
  if (env.ALLOW_DEV_AUTH) problems.push('ALLOW_DEV_AUTH must be false in production — it bypasses Telegram auth.');
  if (env.adminTelegramIds.length === 0) problems.push('ADMIN_TELEGRAM_IDS is empty — nobody could reach the admin panel.');
  if (!env.PLATFORM_WALLET_ADDRESS) problems.push('PLATFORM_WALLET_ADDRESS is required to receive deposits.');
  if (!env.MINI_APP_URL.startsWith('https://')) problems.push('MINI_APP_URL must be HTTPS — Telegram refuses to open plain HTTP Mini Apps.');

  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export function isAdminTelegramId(telegramId: bigint): boolean {
  return env.adminTelegramIds.includes(telegramId);
}
