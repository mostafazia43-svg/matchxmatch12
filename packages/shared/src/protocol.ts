/**
 * WebSocket protocol.
 *
 * Direction is encoded in the type name so a reader never has to guess:
 *   ServerEvent  — server -> client. Authoritative. The client renders these.
 *   ClientEvent  — client -> server. Intent only. The server validates everything.
 *
 * Note what a CLICK does NOT carry: a timestamp. The client cannot tell the
 * server when it clicked; the server timestamps arrival itself. See
 * docs/07-anticheat.md.
 */

import type {
  ConnectionState,
  GameMode,
  MatchView,
  PlayerSlot,
  RoundView,
  WinReason,
} from './types.js';

export const WS_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- client -> server

export type ClientEvent =
  | { t: 'HELLO'; token: string; v: number }
  | { t: 'PONG'; nonce: number }
  | { t: 'QUEUE_JOIN'; mode: GameMode; entryMicros?: string }
  | { t: 'QUEUE_LEAVE' }
  /** Accept the AI opponent offered after a matchmaking timeout. */
  | { t: 'AI_ACCEPT' }
  | { t: 'MATCH_SUBSCRIBE'; matchId: string }
  | { t: 'READY'; matchId: string }
  /** "I pressed the button." No timing data — the server clocks it. */
  | { t: 'CLICK'; matchId: string; roundNo: number; seq: number }
  | { t: 'FORFEIT'; matchId: string };

// ---------------------------------------------------------------- server -> client

export type ServerEvent =
  | { t: 'WELCOME'; userId: string; serverTime: number; v: number }
  | { t: 'PING'; nonce: number; serverTime: number }
  /** Round-trip estimate the server measured; shown as the connection indicator. */
  | { t: 'LATENCY'; rttMs: number }
  | { t: 'QUEUE_STATE'; state: 'WAITING' | 'CANCELLED'; mode: GameMode; waitingMs: number; timeoutMs: number; position?: number }
  | { t: 'QUEUE_ERROR'; code: string; message: string }
  /** Offered when matchmaking times out and an AI opponent is available. */
  | { t: 'AI_OFFER'; mode: GameMode; entryMicros: string; policy: string; message: string; expiresInMs: number }
  | { t: 'MATCH_FOUND'; match: MatchView }
  | { t: 'MATCH_READY'; matchId: string; startsInMs: number }
  | { t: 'COUNTDOWN_START'; matchId: string; roundNo: number; countdownMs: number }
  | { t: 'COUNTDOWN_TICK'; matchId: string; roundNo: number; value: number }
  /**
   * GO — sent AT the moment the button goes live, never in advance.
   *
   * The client is deliberately not told when GO will fire: the countdown ends
   * on an unpredictable jitter, so there is no future instant a modified
   * client could pre-fire against. Clicking before this message is a false
   * start. `deadlineInMs` is the window to respond in.
   */
  | { t: 'ROUND_START'; matchId: string; roundNo: number; deadlineInMs: number }
  /** The countdown finished; the button is armed but not yet live. */
  | { t: 'ROUND_ARMED'; matchId: string; roundNo: number }
  | { t: 'CLICK_ACCEPTED'; matchId: string; roundNo: number; reactionMs: number }
  | { t: 'CLICK_REJECTED'; matchId: string; roundNo: number; reason: 'EARLY' | 'DUPLICATE' | 'CLOSED' | 'TOO_FAST' }
  | { t: 'ROUND_RESULT'; matchId: string; round: RoundView; score: Record<PlayerSlot, number> }
  | { t: 'NEXT_ROUND'; matchId: string; roundNo: number; startsInMs: number }
  | { t: 'MATCH_RESULT'; match: MatchView; youWon: boolean; prizeMicros: string; xpGained: string; pointsGained: string; levelUp: number | null }
  | { t: 'MATCH_CANCELLED'; matchId: string; reason: string; refundMicros: string }
  | { t: 'BALANCE_UPDATED'; availableMicros: string; lockedMicros: string; reason: string }
  | { t: 'PLAYER_DISCONNECTED'; matchId: string; slot: PlayerSlot; graceMs: number }
  | { t: 'PLAYER_RECONNECTED'; matchId: string; slot: PlayerSlot }
  | { t: 'CONNECTION_STATE'; matchId: string; slot: PlayerSlot; state: ConnectionState }
  | { t: 'ERROR'; code: string; message: string };

export type ServerEventType = ServerEvent['t'];
export type ClientEventType = ClientEvent['t'];

export interface RoundOutcome {
  winnerSlot: PlayerSlot | null;
  reason: WinReason;
  reactions: Record<PlayerSlot, number | null>;
  falseStarts: Record<PlayerSlot, boolean>;
}

export function isClientEvent(value: unknown): value is ClientEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string'
  );
}
