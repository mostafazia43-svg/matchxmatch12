/**
 * The authoritative game engine.
 *
 * A live match exists in memory because reaction timing cannot tolerate a
 * database round trip, but memory is a cache, not the record: every
 * transition is persisted, and `recovery.ts` reconciles anything the process
 * loses.
 *
 * The timing model — and why it is shaped this way — is documented in full in
 * docs/07-anticheat.md. The two rules that drive the design:
 *
 *   1. The client is never told WHEN go will happen. The countdown is visible,
 *      but GO fires after an unpredictable jitter and is delivered AT that
 *      instant. There is no future timestamp for a modified client to
 *      pre-fire against.
 *
 *   2. A click carries no timing information. The server stamps arrival with
 *      its own monotonic clock. The only client-influenced input is the
 *      network round trip, which is measured server-side, taken as a MINIMUM
 *      over recent samples, and capped before it can compensate anything.
 */

import { randomInt } from 'node:crypto';
import {
  TIMING,
  computeMatchEconomics,
  matchProgress,
  resolveRound,
  type GameMode,
  type PlayerSlot,
  type ServerEvent,
  type WinReason,
} from '@cb/shared';
import { getSettings, type SettingsMap } from '../../config/settings.js';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { monoNow, monoToDate, schedule } from '../../lib/time.js';
import * as hub from '../../realtime/hub.js';
import { planRound, type AiRoundPlan } from './ai.js';
import { cancelAndRefund, chargeEntries, recordBestReaction, settleMatch } from './settlement.js';
import * as store from './store.js';

// ---------------------------------------------------------------- live state

interface LivePlayer {
  slot: PlayerSlot;
  userId: string | null;
  isAi: boolean;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  connection: 'ONLINE' | 'OFFLINE' | 'FORFEIT';
  /** Cleared when the player comes back within the grace window. */
  disconnectTimer: (() => void) | null;
}

type RoundPhase = 'COUNTDOWN' | 'ARMED' | 'LIVE' | 'RESOLVED';

interface LiveRound {
  roundNo: number;
  phase: RoundPhase;
  /** Monotonic instant GO was sent. Null until the round goes live. */
  goAtMono: number | null;
  deadlineMono: number | null;
  clicks: Record<PlayerSlot, number | null>;
  falseStarts: Record<PlayerSlot, boolean>;
  /** Guards against a duplicate CLICK being counted twice. */
  clicked: Record<PlayerSlot, boolean>;
  aiPlan: AiRoundPlan | null;
  timers: (() => void)[];
}

interface LiveMatch {
  id: string;
  mode: GameMode;
  entryMicros: bigint;
  commissionBps: number;
  prizeMicros: bigint;
  roundsToWin: number;
  maxRounds: number;
  score: Record<PlayerSlot, number>;
  players: Record<PlayerSlot, LivePlayer>;
  round: LiveRound | null;
  roundsPlayed: number;
  finished: boolean;
  settings: SettingsMap;
  timers: (() => void)[];
}

const live = new Map<string, LiveMatch>();
/** userId -> matchId, so a socket event can find its match in O(1). */
const userMatch = new Map<string, string>();

export function liveMatchFor(userId: string): string | null {
  return userMatch.get(userId) ?? null;
}

export function liveMatchCount(): number {
  return live.size;
}

function opponentOf(slot: PlayerSlot): PlayerSlot {
  return slot === 1 ? 2 : 1;
}

function eachPlayer(match: LiveMatch): LivePlayer[] {
  return [match.players[1], match.players[2]];
}

function broadcast(match: LiveMatch, event: ServerEvent): void {
  for (const player of eachPlayer(match)) {
    if (player.userId) hub.sendTo(player.userId, event);
  }
}

function clearTimers(target: { timers: (() => void)[] }): void {
  for (const cancel of target.timers) cancel();
  target.timers = [];
}

// ---------------------------------------------------------------- match start

export interface StartMatchSpec {
  mode: GameMode;
  entryMicros: bigint;
  players: {
    slot: PlayerSlot;
    userId: string | null;
    isAi: boolean;
    displayName: string;
    avatarUrl: string | null;
    level: number;
  }[];
}

/**
 * Create a match, charge both entries, and start round 1.
 *
 * Entries are charged here — at the moment a real match exists — rather than
 * when the player queued. If this transaction fails, nobody has been charged
 * and no match exists.
 */
export async function startMatch(spec: StartMatchSpec): Promise<string> {
  const settings = await getSettings();
  const econ = computeMatchEconomics(spec.entryMicros, settings['game.commission_bps']);
  const isPaid = spec.mode === 'PAID';

  const matchId = await withTransaction(async (tx) => {
    const id = await store.createMatch(tx, {
      mode: spec.mode,
      entryMicros: spec.entryMicros,
      commissionBps: isPaid ? settings['game.commission_bps'] : 0,
      commissionMicros: isPaid ? econ.commissionTotalMicros : 0n,
      prizeMicros: isPaid ? econ.prizeMicros : 0n,
      roundsToWin: settings['game.rounds_to_win'],
      maxRounds: settings['game.max_rounds'],
      isAiMatch: spec.players.some((p) => p.isAi),
      players: spec.players,
    });

    if (isPaid) {
      await chargeEntries(tx, {
        matchId: id,
        entryMicros: spec.entryMicros,
        commissionBps: settings['game.commission_bps'],
        players: spec.players.map((p) => ({ slot: p.slot, userId: p.userId, isAi: p.isAi })),
      });
    }

    await store.recordEvent(tx, {
      matchId: id,
      type: 'MATCH_CREATED',
      payload: {
        mode: spec.mode,
        entryMicros: spec.entryMicros.toString(),
        prizeMicros: isPaid ? econ.prizeMicros.toString() : '0',
      },
    });

    return id;
  });

  const bySlot = (slot: PlayerSlot): LivePlayer => {
    const found = spec.players.find((p) => p.slot === slot)!;
    return { ...found, connection: 'ONLINE', disconnectTimer: null };
  };

  const match: LiveMatch = {
    id: matchId,
    mode: spec.mode,
    entryMicros: spec.entryMicros,
    commissionBps: isPaid ? settings['game.commission_bps'] : 0,
    prizeMicros: isPaid ? econ.prizeMicros : 0n,
    roundsToWin: settings['game.rounds_to_win'],
    maxRounds: settings['game.max_rounds'],
    score: { 1: 0, 2: 0 },
    players: { 1: bySlot(1), 2: bySlot(2) },
    round: null,
    roundsPlayed: 0,
    finished: false,
    settings,
    timers: [],
  };

  live.set(matchId, match);
  for (const player of eachPlayer(match)) {
    if (player.userId) userMatch.set(player.userId, matchId);
  }

  // Send each player their own view so `isSelf` is correct per recipient.
  for (const player of eachPlayer(match)) {
    if (!player.userId) continue;
    const view = await store.matchView(matchId, player.userId);
    if (view) hub.sendTo(player.userId, { t: 'MATCH_FOUND', match: view });
  }

  match.timers.push(schedule(() => void beginRound(match, 1), 1_200));
  return matchId;
}

// ---------------------------------------------------------------- round loop

async function beginRound(match: LiveMatch, roundNo: number): Promise<void> {
  if (match.finished || !live.has(match.id)) return;

  const countdownMs = match.settings['game.countdown_ms'];
  const round: LiveRound = {
    roundNo,
    phase: 'COUNTDOWN',
    goAtMono: null,
    deadlineMono: null,
    clicks: { 1: null, 2: null },
    falseStarts: { 1: false, 2: false },
    clicked: { 1: false, 2: false },
    aiPlan: null,
    timers: [],
  };
  match.round = round;

  await withTransaction((tx) => store.setMatchStatus(tx, match.id, 'ROUND_ACTIVE', roundNo)).catch(
    (error) => logger.error({ err: error, matchId: match.id }, 'failed to persist round status'),
  );

  broadcast(match, { t: 'COUNTDOWN_START', matchId: match.id, roundNo, countdownMs });

  // Visible 3-2-1. Purely cosmetic — the real start is the jittered GO below.
  const ticks = Math.min(3, Math.floor(countdownMs / 1000));
  for (let i = 0; i < ticks; i++) {
    const value = ticks - i;
    round.timers.push(
      schedule(() => {
        broadcast(match, { t: 'COUNTDOWN_TICK', matchId: match.id, roundNo, value });
      }, (i * countdownMs) / ticks),
    );
  }

  round.timers.push(
    schedule(() => {
      if (match.round !== round || match.finished) return;
      round.phase = 'ARMED';
      broadcast(match, { t: 'ROUND_ARMED', matchId: match.id, roundNo });

      // The unpredictable part. A client cannot pre-fire against a moment it
      // has not been told about; clicking during ARMED is a false start.
      const jitterMin = match.settings['game.go_jitter_min_ms'];
      const jitterMax = Math.max(jitterMin, match.settings['game.go_jitter_max_ms']);
      const jitter = jitterMin + randomInt(0, jitterMax - jitterMin + 1);

      round.timers.push(schedule(() => void fireGo(match, round), jitter));
    }, countdownMs),
  );
}

async function fireGo(match: LiveMatch, round: LiveRound): Promise<void> {
  if (match.finished || match.round !== round || round.phase !== 'ARMED') return;

  const timeoutMs = match.settings['game.round_timeout_ms'];
  const goAt = monoNow();
  round.goAtMono = goAt;
  round.deadlineMono = goAt + timeoutMs;
  round.phase = 'LIVE';

  // GO is delivered now, to both players, in the same tick.
  broadcast(match, {
    t: 'ROUND_START',
    matchId: match.id,
    roundNo: round.roundNo,
    deadlineInMs: timeoutMs,
  });

  await withTransaction((tx) =>
    store.openRound(tx, match.id, round.roundNo, monoToDate(goAt), monoToDate(goAt + timeoutMs)),
  ).catch((error) => logger.error({ err: error, matchId: match.id }, 'failed to persist round'));

  scheduleAi(match, round);

  round.timers.push(
    schedule(() => void resolveCurrentRound(match, round), timeoutMs + 50),
  );
}

function scheduleAi(match: LiveMatch, round: LiveRound): void {
  const aiPlayer = eachPlayer(match).find((p) => p.isAi);
  if (!aiPlayer) return;

  const plan = round.aiPlan ?? planRound(match.settings);
  round.aiPlan = plan;

  if (plan.falseStart) {
    // The bot jumps the gun exactly as a human would: a click before GO.
    // (Scheduled at GO-time here, so it registers as an early click.)
    applyClick(match, round, aiPlayer.slot, round.goAtMono! - randomInt(50, 400));
    return;
  }
  if (plan.reactionMs === null) return; // the bot misses this round

  round.timers.push(
    schedule(() => {
      if (match.round !== round || round.phase !== 'LIVE') return;
      applyClick(match, round, aiPlayer.slot, monoNow());
    }, plan.reactionMs),
  );
}

// ---------------------------------------------------------------- clicks

export type ClickOutcome =
  | { accepted: true; reactionMs: number }
  | { accepted: false; reason: 'EARLY' | 'DUPLICATE' | 'CLOSED' | 'TOO_FAST' };

/**
 * Handle a CLICK from a real player.
 *
 * `arrivalMono` is stamped by the caller the instant the frame was read off
 * the socket — before any parsing or database work — so queueing inside the
 * process cannot be mistaken for a slow reaction.
 */
export function registerClick(
  userId: string,
  matchId: string,
  roundNo: number,
  arrivalMono: number,
): ClickOutcome {
  const match = live.get(matchId);
  if (!match || match.finished) return { accepted: false, reason: 'CLOSED' };

  const player = eachPlayer(match).find((p) => p.userId === userId);
  if (!player) return { accepted: false, reason: 'CLOSED' };

  const round = match.round;
  if (!round || round.roundNo !== roundNo || round.phase === 'RESOLVED') {
    return { accepted: false, reason: 'CLOSED' };
  }
  if (round.clicked[player.slot]) return { accepted: false, reason: 'DUPLICATE' };

  return applyClick(match, round, player.slot, arrivalMono);
}

function applyClick(
  match: LiveMatch,
  round: LiveRound,
  slot: PlayerSlot,
  arrivalMono: number,
): ClickOutcome {
  if (round.clicked[slot]) return { accepted: false, reason: 'DUPLICATE' };
  round.clicked[slot] = true;

  const player = match.players[slot];

  // Clicked before GO was even sent — a guess, or a modified client.
  if (round.phase !== 'LIVE' || round.goAtMono === null) {
    round.falseStarts[slot] = true;
    flagAndResolve(match, round, slot, 'EARLY_CLICK', { phase: round.phase });
    return { accepted: false, reason: 'EARLY' };
  }

  const rawReaction = arrivalMono - round.goAtMono;
  const compensation = player.isAi ? 0 : compensationFor(match, player);
  const reactionMs = Math.round(rawReaction - compensation);

  const minHuman = match.settings['game.min_human_reaction_ms'];

  if (reactionMs < 0) {
    round.falseStarts[slot] = true;
    flagAndResolve(match, round, slot, 'PRE_GO_CLICK', { rawReaction, compensation });
    return { accepted: false, reason: 'EARLY' };
  }

  if (reactionMs < minHuman) {
    // Physically implausible: an auto-clicker, or a replayed packet.
    round.falseStarts[slot] = true;
    flagAndResolve(match, round, slot, 'IMPOSSIBLE_REACTION', { reactionMs, minHuman });
    return { accepted: false, reason: 'TOO_FAST' };
  }

  round.clicks[slot] = reactionMs;

  if (player.userId && !player.isAi) {
    void recordBestReaction(player.userId, reactionMs);
    hub.sendTo(player.userId, {
      t: 'CLICK_ACCEPTED',
      matchId: match.id,
      roundNo: round.roundNo,
      reactionMs,
    });
  }

  // Both players are in — no reason to wait for the deadline.
  if (round.clicked[1] && round.clicked[2]) {
    void resolveCurrentRound(match, round);
  }

  return { accepted: true, reactionMs };
}

/**
 * Latency compensation, deliberately conservative.
 *
 * The GO message spends ~rtt/2 travelling out and the click spends ~rtt/2
 * coming back, so a full RTT of the measured reaction is network, not human.
 * `hub.rttFor` returns the MINIMUM recent sample, and the result is capped, so
 * a client that stalls its pongs to fake high latency gains at most the cap
 * rather than an unbounded head start.
 */
function compensationFor(match: LiveMatch, player: LivePlayer): number {
  if (!player.userId) return 0;
  const rtt = hub.rttFor(player.userId);
  const cap = Math.min(
    match.settings['game.max_rtt_compensation_ms'],
    TIMING.MAX_TRUSTED_RTT_MS,
  );
  return Math.min(Math.max(rtt, 0), cap);
}

function flagAndResolve(
  match: LiveMatch,
  round: LiveRound,
  slot: PlayerSlot,
  kind: string,
  detail: Record<string, unknown>,
): void {
  const player = match.players[slot];
  if (player.userId) {
    hub.sendTo(player.userId, {
      t: 'CLICK_REJECTED',
      matchId: match.id,
      roundNo: round.roundNo,
      reason: kind === 'IMPOSSIBLE_REACTION' ? 'TOO_FAST' : 'EARLY',
    });
  }

  void store
    .recordEvent(null, {
      matchId: match.id,
      roundNo: round.roundNo,
      userId: player.userId,
      type: kind,
      payload: { slot, ...detail },
    })
    .catch(() => undefined);

  // Only a physically impossible reaction is treated as evidence of tampering.
  // Jumping the start is a normal human mistake and is punished by the rules,
  // not escalated to the admin queue.
  if (kind === 'IMPOSSIBLE_REACTION' && player.userId && !player.isAi) {
    void store
      .flagSuspicious(null, {
        userId: player.userId,
        matchId: match.id,
        kind,
        severity: 3,
        detail,
      })
      .catch(() => undefined);
  }

  // A false start ends the round immediately — there is nothing left to decide.
  void resolveCurrentRound(match, round);
}

// ---------------------------------------------------------------- resolution

async function resolveCurrentRound(match: LiveMatch, round: LiveRound): Promise<void> {
  if (match.round !== round || round.phase === 'RESOLVED' || match.finished) return;
  round.phase = 'RESOLVED';
  clearTimers(round);

  const outcome = resolveRound({
    1: {
      reactionMs: round.clicks[1],
      falseStart: round.falseStarts[1],
      forfeit: match.players[1].connection === 'FORFEIT',
    },
    2: {
      reactionMs: round.clicks[2],
      falseStart: round.falseStarts[2],
      forfeit: match.players[2].connection === 'FORFEIT',
    },
  });

  if (outcome.winnerSlot) match.score[outcome.winnerSlot] += 1;
  match.roundsPlayed += 1;

  const record = {
    matchId: match.id,
    roundNo: round.roundNo,
    winnerSlot: outcome.winnerSlot,
    winReason: outcome.reason as WinReason,
    reactions: round.clicks,
    falseStarts: round.falseStarts,
  };

  await withTransaction(async (tx) => {
    await store.closeRound(tx, record);
    await store.setMatchStatus(tx, match.id, 'ROUND_FINISHED', round.roundNo);
  }).catch((error) => logger.error({ err: error, matchId: match.id }, 'failed to persist round result'));

  broadcast(match, {
    t: 'ROUND_RESULT',
    matchId: match.id,
    round: {
      roundNo: round.roundNo,
      status: 'FINISHED',
      winnerSlot: outcome.winnerSlot,
      winReason: outcome.reason,
      reactions: round.clicks,
      falseStarts: round.falseStarts,
    },
    score: { ...match.score },
  });

  const progress = matchProgress({
    score: match.score,
    roundsPlayed: match.roundsPlayed,
    roundsToWin: match.roundsToWin,
    maxRounds: match.maxRounds,
  });

  if (progress.finished && progress.champion) {
    await finishMatch(match, progress.champion);
    return;
  }

  // A hard cap on sudden death: an endless tie would otherwise keep two
  // players (and their locked stake) in limbo forever.
  if (match.roundsPlayed >= match.maxRounds + 6) {
    await abortMatch(match, 'Unable to determine a champion — match voided and entries returned.');
    return;
  }

  const gapMs = match.settings['game.inter_round_ms'];
  broadcast(match, {
    t: 'NEXT_ROUND',
    matchId: match.id,
    roundNo: progress.nextRoundNo,
    startsInMs: gapMs,
  });
  match.timers.push(schedule(() => void beginRound(match, progress.nextRoundNo), gapMs));
}

async function finishMatch(match: LiveMatch, championSlot: PlayerSlot): Promise<void> {
  if (match.finished) return;
  match.finished = true;
  clearTimers(match);
  if (match.round) clearTimers(match.round);

  const settlements = await settleMatch({
    matchId: match.id,
    mode: match.mode,
    entryMicros: match.entryMicros,
    commissionBps: match.commissionBps,
    championSlot,
    players: eachPlayer(match).map((p) => ({
      slot: p.slot,
      userId: p.userId,
      isAi: p.isAi,
      roundsWon: match.score[p.slot],
    })),
  }).catch((error) => {
    logger.error({ err: error, matchId: match.id }, 'settlement failed');
    return [];
  });

  for (const player of eachPlayer(match)) {
    if (!player.userId) continue;
    const view = await store.matchView(match.id, player.userId);
    const settlement = settlements.find((s) => s.userId === player.userId);
    if (!view) continue;

    hub.sendTo(player.userId, {
      t: 'MATCH_RESULT',
      match: view,
      youWon: player.slot === championSlot,
      prizeMicros: (settlement?.prizeMicros ?? 0n).toString(),
      xpGained: (settlement?.xpGained ?? 0n).toString(),
      pointsGained: (settlement?.pointsGained ?? 0n).toString(),
      levelUp: settlement?.levelUp ?? null,
    });

    if (settlement) {
      hub.sendTo(player.userId, {
        t: 'BALANCE_UPDATED',
        availableMicros: settlement.availableMicros.toString(),
        lockedMicros: settlement.lockedMicros.toString(),
        reason: settlement.won ? 'PRIZE' : 'MATCH_END',
      });
    }
  }

  teardown(match);
}

async function abortMatch(match: LiveMatch, reason: string): Promise<void> {
  if (match.finished) return;
  match.finished = true;
  clearTimers(match);
  if (match.round) clearTimers(match.round);

  const refunds = await cancelAndRefund(match.id, reason).catch((error) => {
    logger.error({ err: error, matchId: match.id }, 'refund on abort failed');
    return [];
  });

  for (const player of eachPlayer(match)) {
    if (!player.userId) continue;
    const refund = refunds.find((r) => r.userId === player.userId);
    hub.sendTo(player.userId, {
      t: 'MATCH_CANCELLED',
      matchId: match.id,
      reason,
      refundMicros: (refund?.refundMicros ?? 0n).toString(),
    });
    if (refund) {
      hub.sendTo(player.userId, {
        t: 'BALANCE_UPDATED',
        availableMicros: refund.availableMicros.toString(),
        lockedMicros: '0',
        reason: 'REFUND',
      });
    }
  }

  teardown(match);
}

function teardown(match: LiveMatch): void {
  clearTimers(match);
  if (match.round) clearTimers(match.round);
  for (const player of eachPlayer(match)) {
    if (player.disconnectTimer) player.disconnectTimer();
    if (player.userId) userMatch.delete(player.userId);
  }
  live.delete(match.id);
}

// ---------------------------------------------------------------- presence

export function handleDisconnect(userId: string): void {
  const matchId = userMatch.get(userId);
  if (!matchId) return;
  const match = live.get(matchId);
  if (!match || match.finished) return;

  const player = eachPlayer(match).find((p) => p.userId === userId);
  if (!player || player.connection === 'FORFEIT') return;

  // Another tab or device is still connected — not a real disconnect.
  if (hub.isOnline(userId)) return;

  player.connection = 'OFFLINE';
  void store.setConnectionState(match.id, player.slot, 'OFFLINE').catch(() => undefined);

  const graceMs = match.settings['game.disconnect_grace_ms'];
  broadcast(match, {
    t: 'PLAYER_DISCONNECTED',
    matchId: match.id,
    slot: player.slot,
    graceMs,
  });

  player.disconnectTimer = schedule(() => {
    if (match.finished || hub.isOnline(userId)) return;
    player.connection = 'FORFEIT';
    void store.setConnectionState(match.id, player.slot, 'FORFEIT').catch(() => undefined);
    logger.info({ matchId: match.id, slot: player.slot }, 'player forfeited after grace period');
    void finishMatch(match, opponentOf(player.slot));
  }, graceMs);
}

export function handleReconnect(userId: string): void {
  const matchId = userMatch.get(userId);
  if (!matchId) return;
  const match = live.get(matchId);
  if (!match || match.finished) return;

  const player = eachPlayer(match).find((p) => p.userId === userId);
  if (!player || player.connection === 'FORFEIT') return;

  if (player.disconnectTimer) {
    player.disconnectTimer();
    player.disconnectTimer = null;
  }
  player.connection = 'ONLINE';
  void store.setConnectionState(match.id, player.slot, 'ONLINE').catch(() => undefined);
  broadcast(match, { t: 'PLAYER_RECONNECTED', matchId: match.id, slot: player.slot });
}

export function forfeit(userId: string, matchId: string): boolean {
  const match = live.get(matchId);
  if (!match || match.finished) return false;
  const player = eachPlayer(match).find((p) => p.userId === userId);
  if (!player) return false;

  player.connection = 'FORFEIT';
  void store.setConnectionState(match.id, player.slot, 'FORFEIT').catch(() => undefined);
  void finishMatch(match, opponentOf(player.slot));
  return true;
}

/** Cancel every live match — used on graceful shutdown so nothing is left locked. */
export async function drain(reason = 'Server restarting'): Promise<void> {
  const matches = [...live.values()];
  await Promise.allSettled(matches.map((match) => abortMatch(match, reason)));
}
