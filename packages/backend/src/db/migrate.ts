/**
 * Migration runner.
 *
 * Applies every .sql file in database/migrations in filename order, exactly
 * once, inside a transaction, with an advisory lock so two booting instances
 * cannot race. Files are checksummed: editing an already-applied migration is
 * an error rather than a silent divergence between environments.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { closePool, pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // Works from src/ (tsx) and dist/ (compiled).
  for (const candidate of [
    resolve(here, '../../../../database/migrations'),
    resolve(here, '../../../database/migrations'),
    resolve(process.cwd(), 'database/migrations'),
    resolve(process.cwd(), '../../database/migrations'),
  ]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error('Could not locate database/migrations');
}

const LOCK_ID = 774_155_301; // arbitrary but stable

export async function runMigrations(): Promise<{ applied: string[]; skipped: number }> {
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  const applied: string[] = [];
  let skipped = 0;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const known = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 32);
      const previous = known.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} changed after it was applied. ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped++;
        continue;
      }

      logger.info({ migration: file }, 'applying migration');
      try {
        // Each file manages its own BEGIN/COMMIT; the bookkeeping row is
        // written in a separate statement so a failed file leaves no trace.
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        applied.push(file);
      } catch (error) {
        logger.error({ err: error, migration: file }, 'migration failed');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }

  return { applied, skipped };
}

const isDirectRun =
  process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').includes('db/migrate');

if (isDirectRun) {
  runMigrations()
    .then(({ applied, skipped }) => {
      logger.info({ applied: applied.length, skipped }, 'migrations complete');
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error({ err: error }, 'migration run failed');
      process.exit(1);
    });
}
