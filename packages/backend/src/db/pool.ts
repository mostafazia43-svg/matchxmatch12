/**
 * PostgreSQL access.
 *
 * `pg` returns BIGINT columns as strings, which is exactly what we want: they
 * are converted to `bigint` explicitly at the module boundary. Letting them
 * become JS numbers would silently corrupt any balance above 2^53 micros.
 */

import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  application_name: 'clickbattle',
  // Fail fast rather than piling up requests behind a dead database.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'idle postgres client error');
});

export type QueryParam = string | number | bigint | boolean | Date | null | undefined | object;

export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParam[],
  ): Promise<pg.QueryResult<T>>;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export type Tx = pg.PoolClient;

/**
 * Run `fn` inside a single transaction.
 *
 * Every money mutation goes through here. If `fn` throws, the ROLLBACK is
 * unconditional — a partially applied transfer is never left behind, which is
 * what makes "never lose financial records because of a crash" true rather
 * than aspirational.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. Used to turn a race into an idempotent no-op. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** Postgres check-constraint violation — e.g. a balance going negative. */
export function isCheckViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23514';
}

export function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

export async function healthcheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
