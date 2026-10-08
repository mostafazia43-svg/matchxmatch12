/** Domain types shared by the backend, the bot and the Mini App. */

export type GameMode = 'FREE' | 'PAID' | 'DEMO';

export type MatchStatus =
  | 'MATCHED'
  | 'COUNTDOWN'
  | 'ROUND_ACTIVE'
  | 'ROUND_FINISHED'
  | 'MATCH_FINISHED'
  | 'CANCELLED';

export type QueueState = 'WAITING' | 'MATCHED' | 'CANCELLED';

export type RoundStatus = 'COUNTDOWN' | 'ACTIVE' | 'FINISHED' | 'VOID';

export type WinReason = 'FASTEST' | 'FALSE_START' | 'TIMEOUT' | 'FORFEIT' | 'TIE';

export type PlayerSlot = 1 | 2;

export type ConnectionState = 'ONLINE' | 'OFFLINE' | 'FORFEIT';

export type TransactionType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'MATCH_ENTRY'
  | 'COMMISSION'
  | 'PRIZE'
  | 'REFUND'
  | 'ADMIN_ADJUSTMENT';

export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

export type WithdrawalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED';

/** How the platform behaves when no human opponent is found in Paid mode. */
export type PaidAiPolicy = 'DISABLED' | 'REFUND_AND_OFFER' | 'HOUSE_STAKE_DISCLOSED';

export interface PublicUser {
  id: string;
  telegramId: string;
  username: string | null;
  displayName: string;
  photoUrl: string | null;
  level: number;
  isAdmin: boolean;
}

export interface PlayerProgress {
  level: number;
  xp: string;
  xpIntoLevel: string;
  xpForNextLevel: string;
  points: string;
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
  freeMatches: number;
  freeWins: number;
  paidMatches: number;
  paidWins: number;
  bestReactionMs: number | null;
  currentStreak: number;
  bestStreak: number;
}

export interface WalletSummary {
  /** micro-USDT as a decimal string — JSON has no bigint. */
  availableMicros: string;
  lockedMicros: string;
  totalDepositedMicros: string;
  totalWithdrawnMicros: string;
  currency: 'USDT';
  tonAddress: string | null;
  depositAddress: string;
  depositMemo: string;
}

export interface MatchPlayerView {
  slot: PlayerSlot;
  userId: string | null;
  isAi: boolean;
  isSelf: boolean;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  roundsWon: number;
  connection: ConnectionState;
}

export interface RoundView {
  roundNo: number;
  status: RoundStatus;
  winnerSlot: PlayerSlot | null;
  winReason: WinReason | null;
  reactions: { 1: number | null; 2: number | null };
  falseStarts: { 1: boolean; 2: boolean };
}

export interface MatchView {
  id: string;
  shortCode: string;
  mode: GameMode;
  status: MatchStatus;
  entryMicros: string;
  commissionMicros: string;
  prizeMicros: string;
  roundsToWin: number;
  maxRounds: number;
  currentRound: number;
  isAiMatch: boolean;
  aiDisclosed: boolean;
  winnerSlot: PlayerSlot | null;
  players: MatchPlayerView[];
  rounds: RoundView[];
  createdAt: string;
  finishedAt: string | null;
}

export interface TransactionView {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amountMicros: string;
  balanceAfterMicros: string | null;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  photoUrl: string | null;
  level: number;
  xp: string;
  points: string;
  wins: number;
  losses: number;
  winRate: number;
  bestReactionMs: number | null;
  isSelf: boolean;
}

/** Non-secret configuration the Mini App is allowed to know. */
export interface PublicConfig {
  modes: { free: boolean; paid: boolean; demo: boolean };
  paidTiersMicros: string[];
  commissionBps: number;
  roundsToWin: number;
  maxRounds: number;
  countdownMs: number;
  roundTimeoutMs: number;
  matchmakingTimeoutMs: number;
  paidAiPolicy: PaidAiPolicy;
  membership: { enabled: boolean; requiredFor: GameMode[]; inviteUrl: string; chatTitle: string };
  wallet: {
    depositsEnabled: boolean;
    withdrawalsEnabled: boolean;
    minDepositMicros: string;
    minWithdrawalMicros: string;
    withdrawalFeeMicros: string;
    platformAddress: string;
    network: string;
  };
  maintenance: { enabled: boolean; message: string };
}

/** Uniform API envelope. Every endpoint returns this shape. */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
