import { randomBytes, randomUUID } from 'node:crypto';

export const uuid = (): string => randomUUID();

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes

/** Short, human-quotable match code (e.g. "K7QM4X") for support and history. */
export function shortCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Deterministic idempotency key for a ledger row.
 * The SAME logical operation must always produce the SAME key — that is what
 * makes the unique index on wallet_transactions.idempotency_key a real guard
 * against double-crediting a prize or double-charging an entry.
 */
export function ledgerKey(...parts: (string | number | bigint)[]): string {
  return parts.map(String).join(':');
}
