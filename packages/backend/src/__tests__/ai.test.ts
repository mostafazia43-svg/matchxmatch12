import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS } from '../config/settings.js';
import { aiAllowedFor, makeAiProfile, planRound } from '../modules/game/ai.js';

const settings = { ...SETTING_DEFAULTS };

describe('AI opponent', () => {
  it('never reacts faster than a human could', () => {
    const floor = settings['game.min_human_reaction_ms'];
    for (let i = 0; i < 2_000; i++) {
      const plan = planRound(settings);
      if (plan.reactionMs === null) continue;
      expect(plan.reactionMs).toBeGreaterThanOrEqual(settings['ai.reaction_min_ms']);
      expect(plan.reactionMs).toBeGreaterThanOrEqual(floor);
      expect(plan.reactionMs).toBeLessThanOrEqual(settings['ai.reaction_max_ms']);
    }
  });

  it('stays inside the configured bounds even with an extreme distribution', () => {
    const wild = { ...settings, 'ai.reaction_mean_ms': 300, 'ai.reaction_stddev_ms': 500 };
    for (let i = 0; i < 2_000; i++) {
      const plan = planRound(wild);
      if (plan.reactionMs === null) continue;
      expect(plan.reactionMs).toBeGreaterThanOrEqual(wild['ai.reaction_min_ms']);
      expect(plan.reactionMs).toBeLessThanOrEqual(wild['ai.reaction_max_ms']);
    }
  });

  it('makes mistakes — it false-starts and misses like a human', () => {
    const clumsy = { ...settings, 'ai.false_start_chance': 0.3, 'ai.miss_chance': 0.3 };
    let falseStarts = 0;
    let misses = 0;
    for (let i = 0; i < 1_000; i++) {
      const plan = planRound(clumsy);
      if (plan.falseStart) falseStarts++;
      else if (plan.reactionMs === null) misses++;
    }
    expect(falseStarts).toBeGreaterThan(0);
    expect(misses).toBeGreaterThan(0);
  });

  it('produces a spread of reaction times rather than a constant', () => {
    const samples = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const plan = planRound(settings);
      if (plan.reactionMs !== null) samples.add(plan.reactionMs);
    }
    expect(samples.size).toBeGreaterThan(20);
  });

  it('labels itself as AI in its display name', () => {
    for (let i = 0; i < 50; i++) {
      expect(makeAiProfile().displayName).toMatch(/\(AI\)$/);
    }
  });
});

describe('aiAllowedFor', () => {
  it('allows an AI opponent in free and demo modes', () => {
    expect(aiAllowedFor(settings, 'FREE').allowed).toBe(true);
    expect(aiAllowedFor(settings, 'DEMO').allowed).toBe(true);
  });

  it('refuses an AI opponent for real money by default', () => {
    // The default policy must not seat a paying player against the house.
    expect(settings['ai.paid_policy']).toBe('DISABLED');
    const result = aiAllowedFor(settings, 'PAID');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/returned in full/i);
  });

  it('refuses paid AI under REFUND_AND_OFFER too', () => {
    const policy = { ...settings, 'ai.paid_policy': 'REFUND_AND_OFFER' as const };
    expect(aiAllowedFor(policy, 'PAID').allowed).toBe(false);
  });

  it('allows paid AI only when the admin opts in, and only with disclosure', () => {
    const policy = { ...settings, 'ai.paid_policy': 'HOUSE_STAKE_DISCLOSED' as const };
    const result = aiAllowedFor(policy, 'PAID');
    expect(result.allowed).toBe(true);
    expect(result.disclose).toBe(true);
  });

  it('honours the global AI kill switch in every mode', () => {
    const off = { ...settings, 'ai.enabled': false };
    for (const mode of ['FREE', 'PAID', 'DEMO'] as const) {
      expect(aiAllowedFor(off, mode).allowed).toBe(false);
    }
  });
});
