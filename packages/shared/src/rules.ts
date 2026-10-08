/**
 * Pure game rules.
 *
 * These functions are total, deterministic and side-effect free — they take a
 * snapshot of what happened and return what it means. The server calls them to
 * decide outcomes; the tests call them to prove the outcomes; the client never
 * calls them to decide anything, only to render a preview.
 */

import type { PlayerSlot, WinReason } from './types.js';

export interface SlotInput {
  /** Server-computed reaction time, or null if the player never clicked. */
  reactionMs: number | null;
  /** Clicked before GO, or faster than humanly possible. */
  falseStart: boolean;
  /** Disconnected past the grace period, or explicitly quit. */
  forfeit: boolean;
}

export interface RoundInput {
  1: SlotInput;
  2: SlotInput;
}

export interface RoundResolution {
  winnerSlot: PlayerSlot | null;
  reason: WinReason;
}

/**
 * Decide one round.
 *
 * Precedence, highest first:
 *   1. FORFEIT     — a player left; the one still present takes the round.
 *   2. FALSE_START — jumping the gun loses the round outright.
 *   3. TIMEOUT     — one player never clicked; the other takes it.
 *   4. FASTEST     — lower reaction time wins.
 * Symmetric cases (both forfeit, both jump, neither clicks, identical times)
 * resolve to a TIE, which is replayed rather than awarded.
 */
export function resolveRound(input: RoundInput): RoundResolution {
  const p1 = input[1];
  const p2 = input[2];

  if (p1.forfeit || p2.forfeit) {
    if (p1.forfeit && p2.forfeit) return { winnerSlot: null, reason: 'TIE' };
    return { winnerSlot: p1.forfeit ? 2 : 1, reason: 'FORFEIT' };
  }

  if (p1.falseStart || p2.falseStart) {
    if (p1.falseStart && p2.falseStart) return { winnerSlot: null, reason: 'TIE' };
    return { winnerSlot: p1.falseStart ? 2 : 1, reason: 'FALSE_START' };
  }

  const r1 = p1.reactionMs;
  const r2 = p2.reactionMs;

  if (r1 === null && r2 === null) return { winnerSlot: null, reason: 'TIE' };
  if (r1 === null) return { winnerSlot: 2, reason: 'TIMEOUT' };
  if (r2 === null) return { winnerSlot: 1, reason: 'TIMEOUT' };

  if (r1 === r2) return { winnerSlot: null, reason: 'TIE' };
  return { winnerSlot: r1 < r2 ? 1 : 2, reason: 'FASTEST' };
}

export interface MatchProgressInput {
  score: Record<PlayerSlot, number>;
  roundsPlayed: number;
  roundsToWin: number;
  maxRounds: number;
}

export interface MatchProgress {
  champion: PlayerSlot | null;
  finished: boolean;
  /** True when the scheduled rounds are used up with no champion. */
  suddenDeath: boolean;
  nextRoundNo: number;
}

/**
 * Best-of-N with sudden death.
 *
 * A champion needs `roundsToWin` round wins (2 of 3 by default). Ties do not
 * award a round, so three tied rounds leave the score 0-0 — the spec requires
 * play to continue until a champion exists, so extra rounds are appended
 * rather than the match being abandoned. The prize is never paid before
 * `champion` is non-null.
 */
export function matchProgress(input: MatchProgressInput): MatchProgress {
  const s1 = input.score[1] ?? 0;
  const s2 = input.score[2] ?? 0;
  const nextRoundNo = input.roundsPlayed + 1;

  if (s1 >= input.roundsToWin || s2 >= input.roundsToWin) {
    return {
      champion: s1 >= input.roundsToWin ? 1 : 2,
      finished: true,
      suddenDeath: false,
      nextRoundNo,
    };
  }

  const roundsLeft = input.maxRounds - input.roundsPlayed;
  const canStillWin = (score: number) => score + roundsLeft >= input.roundsToWin;

  // Neither player can reach the target within the scheduled rounds — extend.
  const suddenDeath = roundsLeft <= 0 || (!canStillWin(s1) && !canStillWin(s2));

  return { champion: null, finished: false, suddenDeath, nextRoundNo };
}

/**
 * Is this reaction time physically plausible for a human?
 *
 * Sub-100ms is the accepted floor for visual reaction; anything under the
 * configured minimum is an automated clicker or a pre-fired input, and is
 * treated as a false start rather than a win.
 */
export function isPlausibleReaction(reactionMs: number, minHumanMs: number): boolean {
  return Number.isFinite(reactionMs) && reactionMs >= minHumanMs;
}
