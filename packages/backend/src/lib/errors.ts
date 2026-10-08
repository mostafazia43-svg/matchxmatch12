/**
 * Application errors.
 *
 * Every failure the client can see is an `AppError` with a stable code from
 * `@cb/shared`. Anything else that escapes becomes a generic INTERNAL — an
 * unexpected exception must never leak a stack trace, a SQL fragment or a
 * balance into an API response.
 */

import { ErrorCode, type ErrorCodeValue } from '@cb/shared';

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;
  readonly details?: unknown;
  /** Safe to show the end user verbatim. */
  readonly exposeMessage: boolean;

  constructor(
    code: ErrorCodeValue,
    message: string,
    statusCode = 400,
    options: { details?: unknown; expose?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.exposeMessage = options.expose ?? true;
  }
}

export const errors = {
  unauthorized: (message = 'Authentication required.') =>
    new AppError(ErrorCode.UNAUTHORIZED, message, 401),

  forbidden: (message = 'You do not have access to this resource.') =>
    new AppError(ErrorCode.FORBIDDEN, message, 403),

  notFound: (message = 'Not found.') => new AppError(ErrorCode.NOT_FOUND, message, 404),

  validation: (message: string, details?: unknown) =>
    new AppError(ErrorCode.VALIDATION, message, 422, { details }),

  rateLimited: (retryAfterMs: number) =>
    new AppError(ErrorCode.RATE_LIMITED, 'Too many requests. Slow down.', 429, {
      details: { retryAfterMs },
    }),

  maintenance: (message: string) => new AppError(ErrorCode.MAINTENANCE, message, 503),

  blocked: (reason: string | null) =>
    new AppError(
      ErrorCode.BLOCKED,
      reason ? `Your account is blocked: ${reason}` : 'Your account is blocked.',
      403,
    ),

  membershipRequired: (inviteUrl: string) =>
    new AppError(ErrorCode.MEMBERSHIP_REQUIRED, 'Join our Telegram channel to continue.', 403, {
      details: { inviteUrl },
    }),

  modeDisabled: (mode: string) =>
    new AppError(ErrorCode.MODE_DISABLED, `${mode} mode is currently disabled.`, 403),

  invalidTier: () =>
    new AppError(ErrorCode.INVALID_TIER, 'That entry amount is not available.', 422),

  insufficientBalance: (requiredMicros: bigint, availableMicros: bigint) =>
    new AppError(ErrorCode.INSUFFICIENT_BALANCE, 'Not enough balance for this entry.', 402, {
      details: {
        requiredMicros: requiredMicros.toString(),
        availableMicros: availableMicros.toString(),
      },
    }),

  alreadyQueued: () =>
    new AppError(ErrorCode.ALREADY_QUEUED, 'You are already searching for a match.', 409),

  alreadyInMatch: (matchId: string) =>
    new AppError(ErrorCode.ALREADY_IN_MATCH, 'You are already in a live match.', 409, {
      details: { matchId },
    }),

  matchNotFound: () => new AppError(ErrorCode.MATCH_NOT_FOUND, 'Match not found.', 404),

  notAParticipant: () =>
    new AppError(ErrorCode.NOT_A_PARTICIPANT, 'You are not a player in this match.', 403),

  invalidState: (message: string) => new AppError(ErrorCode.INVALID_STATE, message, 409),

  duplicateRequest: () =>
    new AppError(ErrorCode.DUPLICATE_REQUEST, 'This request was already processed.', 409),

  withdrawalsDisabled: () =>
    new AppError(ErrorCode.WITHDRAWALS_DISABLED, 'Withdrawals are temporarily disabled.', 503),

  depositsDisabled: () =>
    new AppError(ErrorCode.DEPOSITS_DISABLED, 'Deposits are temporarily disabled.', 503),

  amountTooSmall: (minimumMicros: bigint) =>
    new AppError(ErrorCode.AMOUNT_TOO_SMALL, 'Amount is below the minimum.', 422, {
      details: { minimumMicros: minimumMicros.toString() },
    }),

  invalidAddress: () =>
    new AppError(ErrorCode.INVALID_ADDRESS, 'That does not look like a valid TON address.', 422),

  providerUnavailable: (message = 'The payment provider is unavailable. Try again shortly.') =>
    new AppError(ErrorCode.PROVIDER_UNAVAILABLE, message, 503),

  internal: (message = 'Something went wrong on our side.') =>
    new AppError(ErrorCode.INTERNAL, message, 500, { expose: false }),
};

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalise anything thrown into a client-safe AppError. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  return errors.internal();
}
