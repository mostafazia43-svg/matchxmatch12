/**
 * Money primitives for Click Battle.
 *
 * THE RULE: money is `bigint` micro-USDT everywhere. 1 USDT = 1_000_000 micro.
 * No `number` ever holds a balance, entry fee, commission or prize. Floating
 * point cannot represent 0.1 exactly and a rounding drift of one micro on a
 * ledger is a real, permanent accounting error.
 *
 * The only place a money value becomes a `number` is at the display edge
 * (`formatUsdt`), and that produces a string, not an arithmetic input.
 */

export const MICROS_PER_UNIT = 1_000_000n;
export const CURRENCY = 'USDT' as const;
export const BPS_DENOMINATOR = 10_000n;

/** Parse a human amount ("5", "5.25", 5) into micro-USDT. Rejects sub-micro precision. */
export function toMicros(amount: string | number): bigint {
  const text = typeof amount === 'number' ? amount.toFixed(6) : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`Invalid amount: ${JSON.stringify(amount)}`);
  }
  const negative = text.startsWith('-');
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.');
  if (frac.length > 6) {
    throw new MoneyError(`Amount ${text} exceeds ${CURRENCY} precision (6 decimals)`);
  }
  const micros = BigInt(whole || '0') * MICROS_PER_UNIT + BigInt(frac.padEnd(6, '0') || '0');
  return negative ? -micros : micros;
}

/** Render micro-USDT for display. Always exact — no float involved. */
export function formatMicros(micros: bigint, opts: { decimals?: number; trim?: boolean } = {}): string {
  const decimals = opts.decimals ?? 2;
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_PER_UNIT;
  const frac = (abs % MICROS_PER_UNIT).toString().padStart(6, '0');
  let shown = decimals > 0 ? frac.slice(0, decimals) : '';
  if (opts.trim && shown) shown = shown.replace(/0+$/, '');
  const body = shown ? `${whole}.${shown}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** "$9.50" style label used across the bot and Mini App. */
export function formatUsdt(micros: bigint, opts: { sign?: boolean } = {}): string {
  const sign = opts.sign && micros > 0n ? '+' : '';
  return `${sign}${formatMicros(micros)} ${CURRENCY}`;
}

/**
 * Commission on a single player's entry, rounded DOWN to the micro.
 *
 * Rounding down is deliberate: the house never collects a fraction it did not
 * earn, and the remainder flows into the prize pool. With the spec'd tiers the
 * division is exact anyway ($5 * 5% = $0.25), but the rule must hold for any
 * tier an admin configures later.
 */
export function commissionFor(entryMicros: bigint, commissionBps: number): bigint {
  assertNonNegative(entryMicros, 'entry');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new MoneyError(`commissionBps out of range: ${commissionBps}`);
  }
  return (entryMicros * BigInt(commissionBps)) / BPS_DENOMINATOR;
}

export interface MatchEconomics {
  /** What each player pays. */
  entryMicros: bigint;
  /** Commission taken from EACH player. */
  commissionPerPlayerMicros: bigint;
  /** Commission across both players — the platform's revenue for this match. */
  commissionTotalMicros: bigint;
  /** Sum of both entries. */
  grossMicros: bigint;
  /** What the champion receives. */
  prizeMicros: bigint;
  commissionBps: number;
}

/**
 * The single source of truth for match money, for a 2-player match.
 *
 * Per the product rule, commission is deducted from EACH player's entry
 * separately — not once from the pooled pot:
 *
 *   $5  entry -> $0.25 x2 commission -> $9.50  prize
 *   $10 entry -> $0.50 x2 commission -> $19.00 prize
 *   $30 entry -> $1.50 x2 commission -> $57.00 prize
 *   $50 entry -> $2.50 x2 commission -> $95.00 prize
 *
 * Called ONLY on the server. The client renders the numbers the server sends.
 */
export function computeMatchEconomics(entryMicros: bigint, commissionBps: number): MatchEconomics {
  assertNonNegative(entryMicros, 'entry');
  const commissionPerPlayerMicros = commissionFor(entryMicros, commissionBps);
  const commissionTotalMicros = commissionPerPlayerMicros * 2n;
  const grossMicros = entryMicros * 2n;
  const prizeMicros = grossMicros - commissionTotalMicros;
  if (prizeMicros < 0n) throw new MoneyError('Commission exceeds the pot');
  return {
    entryMicros,
    commissionPerPlayerMicros,
    commissionTotalMicros,
    grossMicros,
    prizeMicros,
    commissionBps,
  };
}

/** Net profit a champion walks away with (prize minus their own stake). */
export function netProfitMicros(econ: MatchEconomics): bigint {
  return econ.prizeMicros - econ.entryMicros;
}

export function assertNonNegative(micros: bigint, label: string): void {
  if (typeof micros !== 'bigint') throw new MoneyError(`${label} must be a bigint`);
  if (micros < 0n) throw new MoneyError(`${label} must not be negative (got ${micros})`);
}

export function assertPositive(micros: bigint, label: string): void {
  assertNonNegative(micros, label);
  if (micros === 0n) throw new MoneyError(`${label} must be greater than zero`);
}

/** JSON cannot carry bigint. Money crosses the wire as a decimal string. */
export function microsToWire(micros: bigint): string {
  return micros.toString();
}

export function wireToMicros(wire: string | number | bigint): bigint {
  if (typeof wire === 'bigint') return wire;
  const text = String(wire);
  if (!/^-?\d+$/.test(text)) throw new MoneyError(`Invalid wire amount: ${text}`);
  return BigInt(text);
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}
