/**
 * AI opponent.
 *
 * The bot plays by exactly the same rules as a human: it reacts to the same
 * server-issued GO, its click is timestamped by the same code path, and it can
 * lose. It has no access to the opponent's reaction time and no ability to
 * "decide" to win — its reaction is drawn before the round from a configured
 * human-plausible distribution and then simply happens.
 *
 * Anything else would make the AI a rigged house player, which is exactly what
 * the paid-mode policy in settings exists to prevent.
 */

import { randomInt } from 'node:crypto';
import type { SettingsMap } from '../../config/settings.js';

export interface AiProfile {
  displayName: string;
  avatarUrl: string | null;
  level: number;
}

export interface AiRoundPlan {
  /** Milliseconds after GO at which the bot clicks, or null if it misses. */
  reactionMs: number | null;
  /** The bot jumped the start and forfeits the round. */
  falseStart: boolean;
}

const NAMES = [
  'Nova', 'Vex', 'Kite', 'Orbit', 'Zeph', 'Rift', 'Echo', 'Flux',
  'Onyx', 'Quill', 'Sable', 'Talon', 'Vector', 'Wisp', 'Zenith',
];

/** Uniform integer in [min, max], from a CSPRNG so it cannot be predicted. */
function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + randomInt(0, Math.floor(max - min) + 1);
}

function randomFloat(): number {
  return randomInt(0, 1_000_000) / 1_000_000;
}

/** Box-Muller: a normal sample, which models human reaction times far better than a uniform draw. */
function gaussian(mean: number, stddev: number): number {
  const u1 = Math.max(randomFloat(), 1e-9);
  const u2 = randomFloat();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

export function makeAiProfile(): AiProfile {
  const name = NAMES[randomInt(0, NAMES.length)] ?? 'Nova';
  return {
    displayName: `${name} (AI)`,
    avatarUrl: null,
    level: randomBetween(3, 24),
  };
}

/**
 * Draw the bot's behaviour for one round.
 * Called BEFORE the round starts and never revised — the outcome is not a
 * function of what the human does.
 */
export function planRound(settings: SettingsMap): AiRoundPlan {
  if (randomFloat() < settings['ai.false_start_chance']) {
    return { reactionMs: null, falseStart: true };
  }
  if (randomFloat() < settings['ai.miss_chance']) {
    return { reactionMs: null, falseStart: false };
  }

  const mean = settings['ai.reaction_mean_ms'];
  const stddev = settings['ai.reaction_stddev_ms'];
  const min = settings['ai.reaction_min_ms'];
  const max = settings['ai.reaction_max_ms'];

  const sample = gaussian(mean, stddev);
  const clamped = Math.round(Math.min(Math.max(sample, min), max));
  return { reactionMs: clamped, falseStart: false };
}

/**
 * Whether an AI opponent may be offered for this mode.
 *
 * Free and demo: yes, that is the point of the fallback.
 * Paid: only under an explicit, disclosed policy. The default is DISABLED,
 * because quietly staking a player's real money against the house is both
 * unfair and the kind of thing that gets a platform shut down.
 */
export function aiAllowedFor(
  settings: SettingsMap,
  mode: 'FREE' | 'PAID' | 'DEMO',
): { allowed: boolean; disclose: boolean; reason: string } {
  if (!settings['ai.enabled']) {
    return { allowed: false, disclose: false, reason: 'AI opponents are disabled.' };
  }
  if (mode !== 'PAID') {
    return { allowed: true, disclose: true, reason: '' };
  }

  switch (settings['ai.paid_policy']) {
    case 'HOUSE_STAKE_DISCLOSED':
      return {
        allowed: true,
        disclose: true,
        reason: 'The house will stake the opposing side. The opponent is clearly labelled as AI.',
      };
    case 'REFUND_AND_OFFER':
    case 'DISABLED':
    default:
      return {
        allowed: false,
        disclose: false,
        reason: 'No opponent found. Your entry has been returned in full.',
      };
  }
}
