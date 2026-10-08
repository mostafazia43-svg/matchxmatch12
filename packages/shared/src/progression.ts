/**
 * XP / level progression.
 *
 * The curve is a formula, not a hard-coded table, so an admin can retune the
 * economy (or extend the ceiling) without a data migration. The generated
 * table is memoised per parameter set because it is read on every match
 * settlement.
 */

export interface LevelCurve {
  /** XP required to advance from level 1 to 2. */
  base: number;
  /** Growth exponent — 1.0 is linear, higher is steeper. */
  exponent: number;
  max: number;
}

export const DEFAULT_LEVEL_CURVE: LevelCurve = { base: 120, exponent: 1.45, max: 200 };

const tableCache = new Map<string, bigint[]>();

/** Cumulative XP thresholds: `table[n]` is the total XP needed to reach level n+1. */
export function levelTable(curve: LevelCurve): bigint[] {
  const key = `${curve.base}:${curve.exponent}:${curve.max}`;
  const cached = tableCache.get(key);
  if (cached) return cached;

  const table: bigint[] = [0n];
  let total = 0n;
  for (let level = 1; level < curve.max; level++) {
    total += BigInt(Math.round(curve.base * Math.pow(level, curve.exponent)));
    table.push(total);
  }
  tableCache.set(key, table);
  return table;
}

/** Total XP required to sit at `level`. Level 1 costs nothing. */
export function xpForLevel(level: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): bigint {
  const table = levelTable(curve);
  const index = Math.min(Math.max(level, 1), curve.max) - 1;
  return table[index] ?? table[table.length - 1] ?? 0n;
}

export interface LevelState {
  level: number;
  xp: bigint;
  /** XP earned since entering the current level. */
  xpIntoLevel: bigint;
  /** XP span of the current level (0 once the ceiling is reached). */
  xpForNextLevel: bigint;
  progress: number;
  isMax: boolean;
}

export function levelFromXp(xp: bigint, curve: LevelCurve = DEFAULT_LEVEL_CURVE): LevelState {
  const table = levelTable(curve);
  const safeXp = xp < 0n ? 0n : xp;

  let level = 1;
  for (let i = table.length - 1; i >= 0; i--) {
    const threshold = table[i];
    if (threshold !== undefined && safeXp >= threshold) {
      level = i + 1;
      break;
    }
  }

  const floor = table[level - 1] ?? 0n;
  const ceiling = table[level] ?? null;
  const isMax = ceiling === null;
  const xpIntoLevel = safeXp - floor;
  const xpForNextLevel = isMax ? 0n : ceiling - floor;
  const progress = isMax || xpForNextLevel === 0n
    ? 1
    : Number(xpIntoLevel * 1000n / xpForNextLevel) / 1000;

  return { level, xp: safeXp, xpIntoLevel, xpForNextLevel, progress, isMax };
}

export interface RewardTable {
  freeWin: number;
  freeLoss: number;
  paidWin: number;
  paidLoss: number;
  demoWin: number;
  demoLoss: number;
  roundWin: number;
}

export interface PointsTable {
  freeWin: number;
  freeLoss: number;
  paidWin: number;
  paidLoss: number;
  streakBonus: number;
}

export interface RewardInput {
  mode: 'FREE' | 'PAID' | 'DEMO';
  won: boolean;
  roundsWon: number;
  /** Consecutive wins INCLUDING this match, used for the streak bonus. */
  streak: number;
}

export interface RewardResult {
  xp: bigint;
  points: bigint;
}

/**
 * Match rewards. Paid matches pay more progression than free ones, per spec.
 * Demo pays nothing by default — it exists to teach, not to farm.
 */
export function computeRewards(
  input: RewardInput,
  xpTable: RewardTable,
  pointsTable: PointsTable,
): RewardResult {
  let xp = 0;
  let points = 0;

  switch (input.mode) {
    case 'FREE':
      xp = input.won ? xpTable.freeWin : xpTable.freeLoss;
      points = input.won ? pointsTable.freeWin : pointsTable.freeLoss;
      break;
    case 'PAID':
      xp = input.won ? xpTable.paidWin : xpTable.paidLoss;
      points = input.won ? pointsTable.paidWin : pointsTable.paidLoss;
      break;
    case 'DEMO':
      xp = input.won ? xpTable.demoWin : xpTable.demoLoss;
      points = 0;
      break;
  }

  xp += xpTable.roundWin * Math.max(0, input.roundsWon);

  // Streak bonus starts at the second consecutive win and does not apply to demo.
  if (input.won && input.mode !== 'DEMO' && input.streak > 1) {
    points += pointsTable.streakBonus * Math.min(input.streak - 1, 10);
  }

  return { xp: BigInt(Math.max(0, Math.round(xp))), points: BigInt(Math.round(points)) };
}
