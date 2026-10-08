/** Values that are structural rather than configurable. */

export const APP_NAME = 'Click Battle';
export const APP_TAGLINE = 'Fastest finger wins.';

/** Error codes returned by the API and over WS. Kept stable for the client. */
export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  RATE_LIMITED: 'RATE_LIMITED',
  MAINTENANCE: 'MAINTENANCE',
  BLOCKED: 'BLOCKED',
  MEMBERSHIP_REQUIRED: 'MEMBERSHIP_REQUIRED',
  MODE_DISABLED: 'MODE_DISABLED',
  INVALID_TIER: 'INVALID_TIER',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  ALREADY_QUEUED: 'ALREADY_QUEUED',
  ALREADY_IN_MATCH: 'ALREADY_IN_MATCH',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  NOT_A_PARTICIPANT: 'NOT_A_PARTICIPANT',
  INVALID_STATE: 'INVALID_STATE',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  WITHDRAWALS_DISABLED: 'WITHDRAWALS_DISABLED',
  DEPOSITS_DISABLED: 'DEPOSITS_DISABLED',
  AMOUNT_TOO_SMALL: 'AMOUNT_TOO_SMALL',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Human-readable labels for the UI. English only, per spec. */
export const MODE_LABEL: Record<string, string> = {
  FREE: 'Free Match',
  PAID: 'Paid Match',
  DEMO: 'Demo',
};

export const WIN_REASON_LABEL: Record<string, string> = {
  FASTEST: 'Fastest click',
  FALSE_START: 'Opponent jumped the start',
  TIMEOUT: 'Opponent did not click',
  FORFEIT: 'Opponent left the match',
  TIE: 'Tied round - replay',
};

/** Anti-cheat / timing bounds that are not admin-tunable. */
export const TIMING = {
  /** Hard floor. The admin-configured minimum can be raised above this, never below. */
  ABSOLUTE_MIN_REACTION_MS: 80,
  /** RTT above this is untrustworthy for compensation; the player is warned instead. */
  MAX_TRUSTED_RTT_MS: 400,
  /** How often the server probes latency on an idle socket. */
  PING_INTERVAL_MS: 10_000,
  /** Socket is dropped after this long without a pong. */
  PONG_TIMEOUT_MS: 30_000,
  /** Rolling window used to smooth the RTT estimate. */
  RTT_SAMPLES: 5,
} as const;

/** Deposit memos are how an on-chain transfer is attributed to a user. */
export const DEPOSIT_MEMO_PREFIX = 'CB-';
