/**
 * Matchmaking.
 *
 * Players wait in per-bucket queues (mode + entry amount). Pairing is
 * first-come-first-served within a bucket, which is the fairest arrangement
 * for a pure reaction game — there is no skill rating to protect a newcomer
 * from, because the button does not care who is pressing it.
 *
 * The paid path is the delicate one: funds are LOCKED on join and released on
 * every exit path (leave, timeout, error, pairing failure). A player must
 * never be able to hold two matches open with the same balance, and must
 * never lose money to a match that did not happen.
 */

import type { GameMode, PlayerSlot } from '@cb/shared';
import { getSettings, isTierAllowed, modeEnabled, type SettingsMap } from '../../config/settings.js';
import { query, withTransaction } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { monoNow, schedule } from '../../lib/time.js';
import * as hub from '../../realtime/hub.js';
import * as ledger from '../wallet/ledger.js';
import { aiAllowedFor, makeAiProfile } from '../game/ai.js';
import * as engine from '../game/engine.js';
import { activeMatchFor } from '../game/store.js';

interface QueueEntry {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  mode: GameMode;
  entryMicros: bigint;
  joinedAtMono: number;
  /** Funds reserved for this entry; released on any exit that is not a match. */
  lockedMicros: bigint;
  timeoutTimer: (() => void) | null;
  aiOfferOpen: boolean;
}

/** bucket key -> ordered waiting players */
const buckets = new Map<string, QueueEntry[]>();
const byUser = new Map<string, QueueEntry>();

function bucketKey(mode: GameMode, entryMicros: bigint): string {
  return `${mode}:${entryMicros.toString()}`;
}

export function queueSize(): number {
  return byUser.size;
}

export function queueBreakdown(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, entries] of buckets) out[key] = entries.length;
  return out;
}

export function isQueued(userId: string): boolean {
  return byUser.has(userId);
}

// ---------------------------------------------------------------- join

export interface JoinRequest {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  mode: GameMode;
  entryMicros: bigint;
}

export async function join(request: JoinRequest): Promise<{ state: 'WAITING' | 'MATCHED'; matchId?: string }> {
  const settings = await getSettings();

  if (settings['ops.maintenance_mode']) throw errors.maintenance(settings['ops.maintenance_message']);
  if (!modeEnabled(settings, request.mode)) throw errors.modeDisabled(request.mode);
  if (byUser.has(request.userId)) throw errors.alreadyQueued();

  const existingMatch = engine.liveMatchFor(request.userId) ?? (await activeMatchFor(request.userId));
  if (existingMatch) throw errors.alreadyInMatch(existingMatch);

  const entryMicros = request.mode === 'PAID' ? request.entryMicros : 0n;
  if (request.mode === 'PAID') {
    if (!isTierAllowed(settings, entryMicros)) throw errors.invalidTier();
  }

  // Demo never touches matchmaking — it starts against the AI immediately.
  if (request.mode === 'DEMO') {
    const matchId = await startAiMatch(request, 0n, settings);
    return { state: 'MATCHED', matchId };
  }

  let lockedMicros = 0n;
  if (entryMicros > 0n) {
    const result = await withTransaction(async (tx) => {
      await ledger.lockWallet(tx, request.userId);
      return ledger.lockFunds(tx, request.userId, entryMicros);
    });
    lockedMicros = entryMicros;
    hub.sendTo(request.userId, {
      t: 'BALANCE_UPDATED',
      availableMicros: result.availableMicros.toString(),
      lockedMicros: result.lockedMicros.toString(),
      reason: 'ENTRY_RESERVED',
    });
  }

  const entry: QueueEntry = {
    userId: request.userId,
    displayName: request.displayName,
    avatarUrl: request.avatarUrl,
    level: request.level,
    mode: request.mode,
    entryMicros,
    joinedAtMono: monoNow(),
    lockedMicros,
    timeoutTimer: null,
    aiOfferOpen: false,
  };

  const key = bucketKey(request.mode, entryMicros);
  const bucket = buckets.get(key) ?? [];

  // Try to pair with the longest-waiting compatible player.
  const opponent = bucket.shift();
  if (opponent) {
    buckets.set(key, bucket);
    byUser.delete(opponent.userId);
    if (opponent.timeoutTimer) opponent.timeoutTimer();

    try {
      const matchId = await pair(opponent, entry, settings);
      return { state: 'MATCHED', matchId };
    } catch (error) {
      logger.error({ err: error }, 'pairing failed; refunding both players');
      await releaseEntry(opponent);
      await releaseEntry(entry);
      throw error;
    }
  }

  bucket.push(entry);
  buckets.set(key, bucket);
  byUser.set(entry.userId, entry);

  const timeoutMs = settings['matchmaking.timeout_ms'];
  entry.timeoutTimer = schedule(() => void onTimeout(entry, settings), timeoutMs);

  hub.sendTo(entry.userId, {
    t: 'QUEUE_STATE',
    state: 'WAITING',
    mode: entry.mode,
    waitingMs: 0,
    timeoutMs,
    position: bucket.length,
  });

  return { state: 'WAITING' };
}

async function pair(a: QueueEntry, b: QueueEntry, settings: SettingsMap): Promise<string> {
  logger.info({ mode: a.mode, entry: a.entryMicros.toString() }, 'pairing two players');

  return engine.startMatch({
    mode: a.mode,
    entryMicros: a.entryMicros,
    players: [
      toPlayer(a, 1),
      toPlayer(b, 2),
    ],
  });
}

function toPlayer(entry: QueueEntry, slot: PlayerSlot) {
  return {
    slot,
    userId: entry.userId,
    isAi: false,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    level: entry.level,
  };
}

// ---------------------------------------------------------------- leave / timeout

export async function leave(userId: string, reason = 'CANCELLED'): Promise<boolean> {
  const entry = byUser.get(userId);
  if (!entry) return false;

  removeFromBucket(entry);
  byUser.delete(userId);
  if (entry.timeoutTimer) entry.timeoutTimer();

  await releaseEntry(entry);
  hub.sendTo(userId, {
    t: 'QUEUE_STATE',
    state: 'CANCELLED',
    mode: entry.mode,
    waitingMs: monoNow() - entry.joinedAtMono,
    timeoutMs: 0,
  });
  logger.debug({ userId, reason }, 'left matchmaking queue');
  return true;
}

function removeFromBucket(entry: QueueEntry): void {
  const key = bucketKey(entry.mode, entry.entryMicros);
  const bucket = buckets.get(key);
  if (!bucket) return;
  const index = bucket.indexOf(entry);
  if (index >= 0) bucket.splice(index, 1);
  if (bucket.length === 0) buckets.delete(key);
  else buckets.set(key, bucket);
}

/** Return reserved funds. Safe to call more than once. */
async function releaseEntry(entry: QueueEntry): Promise<void> {
  if (entry.lockedMicros <= 0n) return;
  const amount = entry.lockedMicros;
  entry.lockedMicros = 0n;

  try {
    const result = await withTransaction((tx) => ledger.releaseLock(tx, entry.userId, amount));
    hub.sendTo(entry.userId, {
      t: 'BALANCE_UPDATED',
      availableMicros: result.availableMicros.toString(),
      lockedMicros: result.lockedMicros.toString(),
      reason: 'ENTRY_RELEASED',
    });
  } catch (error) {
    // Money left locked is recoverable (the reconciliation sweep unlocks it);
    // crashing the queue is not. Log loudly and continue.
    logger.error(
      { err: error, userId: entry.userId, amount: amount.toString() },
      'FAILED TO RELEASE LOCKED FUNDS - needs reconciliation',
    );
  }
}

/**
 * No human opponent appeared.
 *
 * Free/Demo: offer the AI. Paid: obey the configured policy, which defaults to
 * refunding rather than quietly seating the player against the house.
 */
async function onTimeout(entry: QueueEntry, settings: SettingsMap): Promise<void> {
  if (!byUser.has(entry.userId)) return;

  const ai = aiAllowedFor(settings, entry.mode as 'FREE' | 'PAID' | 'DEMO');

  if (!ai.allowed) {
    removeFromBucket(entry);
    byUser.delete(entry.userId);
    await releaseEntry(entry);
    hub.sendTo(entry.userId, {
      t: 'QUEUE_ERROR',
      code: 'NO_OPPONENT',
      message: ai.reason || 'No opponent found. Please try again.',
    });
    return;
  }

  // The player is asked, not conscripted — an AI match they did not choose is
  // exactly the "misleading situation" the spec warns about.
  entry.aiOfferOpen = true;
  hub.sendTo(entry.userId, {
    t: 'AI_OFFER',
    mode: entry.mode,
    entryMicros: entry.entryMicros.toString(),
    policy: settings['ai.paid_policy'],
    message:
      entry.mode === 'PAID'
        ? 'No human opponent found. You can play the house AI for the same stake, or cancel for a full refund.'
        : 'No human opponent found. Play against our AI?',
    expiresInMs: 20_000,
  });

  entry.timeoutTimer = schedule(() => {
    if (!byUser.has(entry.userId) || !entry.aiOfferOpen) return;
    void leave(entry.userId, 'AI_OFFER_EXPIRED');
  }, 20_000);
}

/** The player accepted the AI fallback. */
export async function acceptAiOffer(userId: string): Promise<string> {
  const entry = byUser.get(userId);
  if (!entry || !entry.aiOfferOpen) throw errors.invalidState('There is no AI offer to accept.');

  const settings = await getSettings();
  const ai = aiAllowedFor(settings, entry.mode as 'FREE' | 'PAID' | 'DEMO');
  if (!ai.allowed) {
    await leave(userId, 'AI_NOT_ALLOWED');
    throw errors.forbidden(ai.reason);
  }

  removeFromBucket(entry);
  byUser.delete(userId);
  if (entry.timeoutTimer) entry.timeoutTimer();
  entry.aiOfferOpen = false;

  // Funds stay locked — startMatch consumes them as the entry.
  return startAiMatch(
    {
      userId: entry.userId,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl,
      level: entry.level,
      mode: entry.mode,
      entryMicros: entry.entryMicros,
    },
    entry.entryMicros,
    settings,
  );
}

async function startAiMatch(
  request: JoinRequest,
  entryMicros: bigint,
  _settings: SettingsMap,
): Promise<string> {
  const ai = makeAiProfile();
  return engine.startMatch({
    mode: request.mode,
    entryMicros,
    players: [
      {
        slot: 1,
        userId: request.userId,
        isAi: false,
        displayName: request.displayName,
        avatarUrl: request.avatarUrl,
        level: request.level,
      },
      {
        slot: 2,
        userId: null,
        isAi: true,
        displayName: ai.displayName,
        avatarUrl: ai.avatarUrl,
        level: ai.level,
      },
    ],
  });
}

/** Drop a disconnected player from the queue and give their stake back. */
export async function onDisconnect(userId: string): Promise<void> {
  if (!byUser.has(userId)) return;
  if (hub.isOnline(userId)) return;
  await leave(userId, 'DISCONNECTED');
}

/** Release every queued reservation — called on shutdown. */
export async function drain(): Promise<void> {
  const entries = [...byUser.values()];
  byUser.clear();
  buckets.clear();
  for (const entry of entries) {
    if (entry.timeoutTimer) entry.timeoutTimer();
    await releaseEntry(entry);
  }
}

/**
 * Reconciliation: unlock funds held for a player who is neither queued nor in
 * a live match. Runs at boot, after a crash has orphaned reservations.
 */
export async function reconcileOrphanedLocks(): Promise<number> {
  const rows = await query<{ user_id: string }>(
    `
    WITH orphaned AS (
      SELECT w.user_id, w.locked_micros
        FROM wallets w
       WHERE w.locked_micros > 0
         AND NOT EXISTS (
           SELECT 1 FROM match_players mp
             JOIN matches m ON m.id = mp.match_id
            WHERE mp.user_id = w.user_id
              AND m.status NOT IN ('MATCH_FINISHED','CANCELLED')
         )
    )
    UPDATE wallets w
       SET available_micros = w.available_micros + o.locked_micros,
           locked_micros = 0,
           updated_at = now()
      FROM orphaned o
     WHERE w.user_id = o.user_id
    RETURNING w.user_id
    `,
  );
  const released = rows.length;
  if (released > 0) logger.warn({ wallets: released }, 'released orphaned fund locks left by a previous run');
  return released;
}
