/**
 * Rate limiting.
 *
 * Backed by Redis when available so limits hold across instances, with an
 * in-process fallback for single-node development. The fallback fails OPEN on
 * a Redis error: a limiter outage should not take the game down, and the
 * genuinely dangerous operations (withdrawals, admin writes) are protected by
 * idempotency and authorization rather than by rate limits alone.
 */

import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let redis: Redis | null = null;
let redisHealthy = false;

export function redisClient(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (redis) return redis;

  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5_000),
  });
  redis.on('ready', () => {
    redisHealthy = true;
    logger.info('redis connected');
  });
  redis.on('error', (error: Error) => {
    if (redisHealthy) logger.warn({ err: error }, 'redis error; falling back to in-process limits');
    redisHealthy = false;
  });
  return redis;
}

interface Bucket {
  count: number;
  resetAt: number;
}
const memory = new Map<string, Bucket>();

// Keep the fallback map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of memory) {
    if (bucket.resetAt <= now) memory.delete(key);
  }
}, 60_000).unref();

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function consume(
  key: string,
  limit: number,
  windowMs: number,
): Promise<LimitResult> {
  const client = redisClient();

  if (client && redisHealthy) {
    try {
      const redisKey = `rl:${key}`;
      const count = await client.incr(redisKey);
      if (count === 1) await client.pexpire(redisKey, windowMs);
      const ttl = count > limit ? await client.pttl(redisKey) : 0;
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterMs: Math.max(0, ttl),
      };
    } catch (error) {
      logger.debug({ err: error }, 'redis rate limit failed; using memory');
    }
  }

  const now = Date.now();
  const bucket = memory.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterMs: Math.max(0, bucket.resetAt - now),
  };
}

export async function closeRedis(): Promise<void> {
  if (!redis) return;
  await redis.quit().catch(() => undefined);
  redis = null;
}
