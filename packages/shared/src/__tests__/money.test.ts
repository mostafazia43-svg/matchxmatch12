import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  commissionFor,
  computeMatchEconomics,
  formatMicros,
  formatUsdt,
  microsToWire,
  netProfitMicros,
  toMicros,
  wireToMicros,
} from '../money.js';

describe('toMicros', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(toMicros('5')).toBe(5_000_000n);
    expect(toMicros('5.25')).toBe(5_250_000n);
    expect(toMicros('0.000001')).toBe(1n);
    expect(toMicros(30)).toBe(30_000_000n);
  });

  it('parses the classic float-hazard amounts without drift', () => {
    // 0.1 + 0.2 !== 0.3 in floating point. In micros it is exact.
    expect(toMicros('0.1') + toMicros('0.2')).toBe(toMicros('0.3'));
  });

  it('rejects sub-micro precision and junk', () => {
    expect(() => toMicros('1.0000001')).toThrow(MoneyError);
    expect(() => toMicros('abc')).toThrow(MoneyError);
    expect(() => toMicros('')).toThrow(MoneyError);
  });
});

describe('formatting', () => {
  it('renders exact decimal strings', () => {
    expect(formatMicros(9_500_000n)).toBe('9.50');
    expect(formatMicros(1n, { decimals: 6 })).toBe('0.000001');
    expect(formatMicros(-250_000n)).toBe('-0.25');
    expect(formatUsdt(19_000_000n)).toBe('19.00 USDT');
    expect(formatUsdt(19_000_000n, { sign: true })).toBe('+19.00 USDT');
  });

  it('round-trips across the wire', () => {
    const value = 123_456_789n;
    expect(wireToMicros(microsToWire(value))).toBe(value);
  });
});

describe('commissionFor', () => {
  it('takes 5% of a single entry', () => {
    expect(commissionFor(toMicros('5'), 500)).toBe(toMicros('0.25'));
    expect(commissionFor(toMicros('10'), 500)).toBe(toMicros('0.50'));
    expect(commissionFor(toMicros('30'), 500)).toBe(toMicros('1.50'));
    expect(commissionFor(toMicros('50'), 500)).toBe(toMicros('2.50'));
  });

  it('rounds down so the house never over-collects', () => {
    // 0.000009 USDT at 5% = 0.00000045 -> floors to 0
    expect(commissionFor(9n, 500)).toBe(0n);
    // 33.333333 at 5% = 1.66666665 -> 1.666666
    expect(commissionFor(toMicros('33.333333'), 500)).toBe(1_666_666n);
  });

  it('rejects an out-of-range rate', () => {
    expect(() => commissionFor(toMicros('5'), -1)).toThrow(MoneyError);
    expect(() => commissionFor(toMicros('5'), 10_001)).toThrow(MoneyError);
  });
});

describe('computeMatchEconomics', () => {
  // These are the exact figures the product spec mandates.
  const cases = [
    { entry: '5', perPlayer: '0.25', total: '0.50', gross: '10', prize: '9.50' },
    { entry: '10', perPlayer: '0.50', total: '1', gross: '20', prize: '19' },
    { entry: '30', perPlayer: '1.50', total: '3', gross: '60', prize: '57' },
    { entry: '50', perPlayer: '2.50', total: '5', gross: '100', prize: '95' },
  ];

  for (const c of cases) {
    it(`$${c.entry} tier pays a $${c.prize} prize`, () => {
      const econ = computeMatchEconomics(toMicros(c.entry), 500);
      expect(econ.commissionPerPlayerMicros).toBe(toMicros(c.perPlayer));
      expect(econ.commissionTotalMicros).toBe(toMicros(c.total));
      expect(econ.grossMicros).toBe(toMicros(c.gross));
      expect(econ.prizeMicros).toBe(toMicros(c.prize));
    });
  }

  it('conserves value: gross == prize + commission, always', () => {
    for (const entry of ['5', '10', '30', '50', '0.01', '7.77', '1234.567891']) {
      const econ = computeMatchEconomics(toMicros(entry), 500);
      expect(econ.prizeMicros + econ.commissionTotalMicros).toBe(econ.grossMicros);
    }
  });

  it('reports the champion net profit', () => {
    const econ = computeMatchEconomics(toMicros('5'), 500);
    expect(netProfitMicros(econ)).toBe(toMicros('4.50'));
  });

  it('handles a zero-commission (free) configuration', () => {
    const econ = computeMatchEconomics(toMicros('5'), 0);
    expect(econ.commissionTotalMicros).toBe(0n);
    expect(econ.prizeMicros).toBe(toMicros('10'));
  });

  it('refuses a negative entry', () => {
    expect(() => computeMatchEconomics(-1n, 500)).toThrow(MoneyError);
  });
});
