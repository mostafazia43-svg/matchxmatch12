import { describe, expect, it } from 'vitest';
import { isPlausibleReaction, matchProgress, resolveRound, type SlotInput } from '../rules.js';
import { computeRewards, levelFromXp, xpForLevel, DEFAULT_LEVEL_CURVE } from '../progression.js';

const clean = (reactionMs: number | null): SlotInput => ({
  reactionMs,
  falseStart: false,
  forfeit: false,
});
const jumped: SlotInput = { reactionMs: null, falseStart: true, forfeit: false };
const quit: SlotInput = { reactionMs: null, falseStart: false, forfeit: true };

describe('resolveRound', () => {
  it('awards the round to the faster click', () => {
    expect(resolveRound({ 1: clean(210), 2: clean(240) })).toEqual({
      winnerSlot: 1,
      reason: 'FASTEST',
    });
    expect(resolveRound({ 1: clean(300), 2: clean(299) })).toEqual({
      winnerSlot: 2,
      reason: 'FASTEST',
    });
  });

  it('ties identical reaction times rather than picking a slot', () => {
    expect(resolveRound({ 1: clean(250), 2: clean(250) })).toEqual({
      winnerSlot: null,
      reason: 'TIE',
    });
  });

  it('punishes a false start even when the jumper would have been faster', () => {
    expect(resolveRound({ 1: jumped, 2: clean(900) })).toEqual({
      winnerSlot: 2,
      reason: 'FALSE_START',
    });
  });

  it('ties when both players jump the start', () => {
    expect(resolveRound({ 1: jumped, 2: jumped })).toEqual({ winnerSlot: null, reason: 'TIE' });
  });

  it('awards the round when only one player clicks in time', () => {
    expect(resolveRound({ 1: clean(400), 2: clean(null) })).toEqual({
      winnerSlot: 1,
      reason: 'TIMEOUT',
    });
    expect(resolveRound({ 1: clean(null), 2: clean(null) })).toEqual({
      winnerSlot: null,
      reason: 'TIE',
    });
  });

  it('ranks forfeit above every other rule', () => {
    expect(resolveRound({ 1: quit, 2: jumped })).toEqual({ winnerSlot: 2, reason: 'FORFEIT' });
    expect(resolveRound({ 1: quit, 2: quit })).toEqual({ winnerSlot: null, reason: 'TIE' });
  });
});

describe('matchProgress', () => {
  const base = { roundsToWin: 2, maxRounds: 3 };

  it('keeps playing while the match is live', () => {
    const p = matchProgress({ ...base, score: { 1: 1, 2: 0 }, roundsPlayed: 1 });
    expect(p.finished).toBe(false);
    expect(p.champion).toBeNull();
    expect(p.nextRoundNo).toBe(2);
  });

  it('crowns a champion at two round wins', () => {
    expect(matchProgress({ ...base, score: { 1: 2, 2: 0 }, roundsPlayed: 2 })).toMatchObject({
      champion: 1,
      finished: true,
    });
    // The spec's worked example: A, B, A across three rounds.
    expect(matchProgress({ ...base, score: { 1: 2, 2: 1 }, roundsPlayed: 3 })).toMatchObject({
      champion: 1,
      finished: true,
    });
  });

  it('goes to sudden death when all three rounds tie', () => {
    const p = matchProgress({ ...base, score: { 1: 0, 2: 0 }, roundsPlayed: 3 });
    expect(p.finished).toBe(false);
    expect(p.champion).toBeNull();
    expect(p.suddenDeath).toBe(true);
    expect(p.nextRoundNo).toBe(4);
  });

  it('goes to sudden death when the score is level after the scheduled rounds', () => {
    const p = matchProgress({ ...base, score: { 1: 1, 2: 1 }, roundsPlayed: 3 });
    expect(p.suddenDeath).toBe(true);
    expect(p.champion).toBeNull();
  });

  it('never crowns a champion below the win threshold', () => {
    for (let played = 0; played <= 6; played++) {
      const p = matchProgress({ ...base, score: { 1: 1, 2: 0 }, roundsPlayed: played });
      expect(p.champion).toBeNull();
    }
  });
});

describe('isPlausibleReaction', () => {
  it('rejects inhumanly fast clicks', () => {
    expect(isPlausibleReaction(45, 90)).toBe(false);
    expect(isPlausibleReaction(89, 90)).toBe(false);
    expect(isPlausibleReaction(90, 90)).toBe(true);
    expect(isPlausibleReaction(Number.NaN, 90)).toBe(false);
  });
});

describe('progression', () => {
  it('starts every player at level 1 with zero XP', () => {
    const state = levelFromXp(0n);
    expect(state.level).toBe(1);
    expect(state.xpIntoLevel).toBe(0n);
    expect(state.progress).toBe(0);
  });

  it('advances monotonically and never skips backwards', () => {
    let previous = 1;
    for (let xp = 0; xp < 50_000; xp += 137) {
      const level = levelFromXp(BigInt(xp)).level;
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it('places a player exactly on a threshold in the new level', () => {
    const threshold = xpForLevel(5);
    expect(levelFromXp(threshold).level).toBe(5);
    expect(levelFromXp(threshold - 1n).level).toBe(4);
  });

  it('caps at the configured ceiling', () => {
    const huge = levelFromXp(10n ** 12n);
    expect(huge.level).toBe(DEFAULT_LEVEL_CURVE.max);
    expect(huge.isMax).toBe(true);
    expect(huge.progress).toBe(1);
  });

  const xpTable = {
    freeWin: 25, freeLoss: 8, paidWin: 90, paidLoss: 30,
    demoWin: 0, demoLoss: 0, roundWin: 5,
  };
  const pointsTable = { freeWin: 10, freeLoss: 0, paidWin: 40, paidLoss: 2, streakBonus: 5 };

  it('pays more for paid matches than free ones', () => {
    const free = computeRewards({ mode: 'FREE', won: true, roundsWon: 2, streak: 1 }, xpTable, pointsTable);
    const paid = computeRewards({ mode: 'PAID', won: true, roundsWon: 2, streak: 1 }, xpTable, pointsTable);
    expect(paid.xp).toBeGreaterThan(free.xp);
    expect(paid.points).toBeGreaterThan(free.points);
  });

  it('pays nothing for demo matches', () => {
    const demo = computeRewards({ mode: 'DEMO', won: true, roundsWon: 2, streak: 5 }, xpTable, pointsTable);
    expect(demo.xp).toBe(10n); // round-win XP only
    expect(demo.points).toBe(0n);
  });

  it('adds a streak bonus only from the second consecutive win', () => {
    const first = computeRewards({ mode: 'FREE', won: true, roundsWon: 2, streak: 1 }, xpTable, pointsTable);
    const second = computeRewards({ mode: 'FREE', won: true, roundsWon: 2, streak: 2 }, xpTable, pointsTable);
    expect(second.points - first.points).toBe(5n);
  });

  it('never returns negative rewards', () => {
    const loss = computeRewards({ mode: 'FREE', won: false, roundsWon: 0, streak: 0 }, xpTable, pointsTable);
    expect(loss.xp).toBeGreaterThanOrEqual(0n);
    expect(loss.points).toBeGreaterThanOrEqual(0n);
  });
});
