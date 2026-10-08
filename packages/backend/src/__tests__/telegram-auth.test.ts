import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InitDataError, signInitDataForTest, verifyInitData } from '../modules/auth/telegram.js';

const BOT_TOKEN = '123456:TEST-TOKEN-not-a-real-secret';
const OTHER_TOKEN = '999999:DIFFERENT-TOKEN';

const user = { id: 901505210, first_name: 'Test', username: 'tester', language_code: 'en' };

function verify(initData: string, overrides: Partial<{ maxAgeSeconds: number; now: () => number }> = {}) {
  return verifyInitData(initData, {
    botToken: BOT_TOKEN,
    maxAgeSeconds: overrides.maxAgeSeconds ?? 86_400,
    now: overrides.now ?? Date.now,
  });
}

describe('verifyInitData', () => {
  it('accepts data genuinely signed with the bot token', () => {
    const result = verify(signInitDataForTest(BOT_TOKEN, user));
    expect(result.user.id).toBe(901505210n);
    expect(result.user.username).toBe('tester');
    expect(result.user.firstName).toBe('Test');
  });

  it('rejects data signed with a different bot token', () => {
    expect(() => verify(signInitDataForTest(OTHER_TOKEN, user))).toThrow(InitDataError);
    try {
      verify(signInitDataForTest(OTHER_TOKEN, user));
    } catch (error) {
      expect((error as InitDataError).reason).toBe('BAD_SIGNATURE');
    }
  });

  it('rejects a tampered user id even though every other field is valid', () => {
    // The classic attack: take your own valid initData and swap in someone
    // else's account, or grant yourself the admin id.
    const valid = signInitDataForTest(BOT_TOKEN, user);
    const params = new URLSearchParams(valid);
    params.set('user', JSON.stringify({ ...user, id: 1 }));

    expect(() => verify(params.toString())).toThrow(InitDataError);
  });

  it('rejects a tampered auth_date', () => {
    const valid = signInitDataForTest(BOT_TOKEN, user);
    const params = new URLSearchParams(valid);
    params.set('auth_date', String(Math.floor(Date.now() / 1000)));
    // Same value would still hash differently once anything else moved; force a change.
    params.set('auth_date', String(Math.floor(Date.now() / 1000) + 10));
    expect(() => verify(params.toString())).toThrow(InitDataError);
  });

  it('rejects initData with no hash at all', () => {
    const params = new URLSearchParams({ user: JSON.stringify(user), auth_date: '1700000000' });
    try {
      verify(params.toString());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InitDataError).reason).toBe('MISSING_HASH');
    }
  });

  it('rejects an expired capture, so a stolen string cannot be replayed forever', () => {
    const initData = signInitDataForTest(BOT_TOKEN, user);
    const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;
    try {
      verify(initData, { maxAgeSeconds: 86_400, now: () => twoDaysLater });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InitDataError).reason).toBe('EXPIRED');
    }
  });

  it('rejects an auth_date far in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 10_000;
    const params = new URLSearchParams({
      user: JSON.stringify(user),
      auth_date: String(future),
    });
    const entries = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    params.set('hash', createHmac('sha256', secret).update(entries.join('\n')).digest('hex'));

    try {
      verify(params.toString());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InitDataError).reason).toBe('EXPIRED');
    }
  });

  it('refuses to verify anything when no bot token is configured', () => {
    try {
      verifyInitData(signInitDataForTest(BOT_TOKEN, user), { botToken: '', maxAgeSeconds: 86_400 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InitDataError).reason).toBe('NO_BOT_TOKEN');
    }
  });

  it('rejects malformed and oversized input without throwing something unexpected', () => {
    for (const bad of ['', 'not-a-query-string', 'x'.repeat(9000)]) {
      expect(() => verify(bad)).toThrow(InitDataError);
    }
  });

  it('preserves the signature over extra fields Telegram may add', () => {
    // `signature`, `query_id` etc. are part of the hashed payload; dropping one
    // must invalidate it.
    const initData = signInitDataForTest(BOT_TOKEN, user, { query_id: 'AAH123', signature: 'abc' });
    expect(() => verify(initData)).not.toThrow();

    const params = new URLSearchParams(initData);
    params.delete('query_id');
    expect(() => verify(params.toString())).toThrow(InitDataError);
  });
});
