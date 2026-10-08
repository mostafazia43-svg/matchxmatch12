/**
 * Match persistence and read models.
 *
 * The engine keeps the live match in memory for latency reasons, but every
 * transition is written here first. If the process dies mid-match, the
 * database — not the lost heap — is what recovery reads.
 */

import type {
  GameMode,
  MatchStatus,
  MatchView,
  PlayerSlot,
  RoundStatus,
  RoundView,
  WinReason,
} from '@cb/shared';
import { query, queryOne, type Tx } from '../../db/pool.js';
import { shortCode } from '../../lib/ids.js';

export interface CreateMatchSpec {
  mode: GameMode;
  entryMicros: bigint;
  commissionBps: number;
  commissionMicros: bigint;
  prizeMicros: bigint;
  roundsToWin: number;
  maxRounds: number;
  isAiMatch: boolean;
  players: {
    slot: PlayerSlot;
    userId: string | null;
    isAi: boolean;
    displayName: string;
    avatarUrl: string | null;
    level: number;
  }[];
}

export async function createMatch(tx: Tx, spec: CreateMatchSpec): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `
    INSERT INTO matches
      (short_code, mode, entry_micros, commission_bps, commission_micros, prize_micros,
       status, rounds_to_win, max_rounds, is_ai_match, started_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'COUNTDOWN', $7, $8, $9, now())
    RETURNING id
    `,
    [
      shortCode(),
      spec.mode,
      spec.entryMicros.toString(),
      spec.commissionBps,
      spec.commissionMicros.toString(),
      spec.prizeMicros.toString(),
      spec.roundsToWin,
      spec.maxRounds,
      spec.isAiMatch,
    ],
  );
  const matchId = rows[0]?.id;
  if (!matchId) throw new Error('Failed to create match');

  for (const player of spec.players) {
    await tx.query(
      `INSERT INTO match_players (match_id, slot, user_id, is_ai, display_name, avatar_url, level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        matchId,
        player.slot,
        player.userId,
        player.isAi,
        player.displayName,
        player.avatarUrl,
        player.level,
      ],
    );
  }

  return matchId;
}

export async function setMatchStatus(
  tx: Tx,
  matchId: string,
  status: MatchStatus,
  currentRound?: number,
): Promise<void> {
  await tx.query(
    `UPDATE matches SET status = $2, current_round = COALESCE($3, current_round) WHERE id = $1`,
    [matchId, status, currentRound ?? null],
  );
}

export async function openRound(
  tx: Tx,
  matchId: string,
  roundNo: number,
  goAt: Date,
  deadlineAt: Date,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `
    INSERT INTO rounds (match_id, round_no, status, go_at, deadline_at)
    VALUES ($1, $2, 'ACTIVE', $3, $4)
    ON CONFLICT (match_id, round_no) DO UPDATE
      SET status = 'ACTIVE', go_at = EXCLUDED.go_at, deadline_at = EXCLUDED.deadline_at
    RETURNING id
    `,
    [matchId, roundNo, goAt, deadlineAt],
  );
  return rows[0]!.id;
}

export interface RoundResultRecord {
  matchId: string;
  roundNo: number;
  winnerSlot: PlayerSlot | null;
  winReason: WinReason;
  reactions: Record<PlayerSlot, number | null>;
  falseStarts: Record<PlayerSlot, boolean>;
}

/**
 * Persist a round result.
 *
 * An UPSERT rather than an UPDATE, because a round can end before it ever goes
 * live: a false start during the ARMED phase resolves the round without
 * `openRound` having run, and an UPDATE would silently write nothing — losing
 * the record of exactly the outcome most likely to be disputed.
 */
export async function closeRound(tx: Tx, record: RoundResultRecord): Promise<void> {
  await tx.query(
    `
    INSERT INTO rounds
      (match_id, round_no, status, go_at, deadline_at, winner_slot, win_reason,
       p1_reaction_ms, p2_reaction_ms, p1_false_start, p2_false_start, finished_at)
    VALUES ($1, $2, 'FINISHED', now(), now(), $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (match_id, round_no) DO UPDATE SET
      status         = 'FINISHED',
      winner_slot    = EXCLUDED.winner_slot,
      win_reason     = EXCLUDED.win_reason,
      p1_reaction_ms = EXCLUDED.p1_reaction_ms,
      p2_reaction_ms = EXCLUDED.p2_reaction_ms,
      p1_false_start = EXCLUDED.p1_false_start,
      p2_false_start = EXCLUDED.p2_false_start,
      finished_at    = now()
    `,
    [
      record.matchId,
      record.roundNo,
      record.winnerSlot,
      record.winReason,
      record.reactions[1],
      record.reactions[2],
      record.falseStarts[1],
      record.falseStarts[2],
    ],
  );

  if (record.winnerSlot) {
    await tx.query(
      'UPDATE match_players SET rounds_won = rounds_won + 1 WHERE match_id = $1 AND slot = $2',
      [record.matchId, record.winnerSlot],
    );
  }
}

export async function recordEvent(
  tx: Tx | null,
  event: {
    matchId: string | null;
    roundNo?: number | null;
    userId?: string | null;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const sql = `INSERT INTO game_events (match_id, round_no, user_id, type, payload)
               VALUES ($1, $2, $3, $4, $5::jsonb)`;
  const params = [
    event.matchId,
    event.roundNo ?? null,
    event.userId ?? null,
    event.type,
    JSON.stringify(event.payload ?? {}),
  ];
  if (tx) await tx.query(sql, params);
  else await queryOne(sql, params);
}

export async function flagSuspicious(
  tx: Tx | null,
  entry: {
    userId: string | null;
    matchId?: string | null;
    kind: string;
    severity?: number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const sql = `INSERT INTO suspicious_events (user_id, match_id, kind, severity, detail)
               VALUES ($1, $2, $3, $4, $5::jsonb)`;
  const params = [
    entry.userId,
    entry.matchId ?? null,
    entry.kind,
    entry.severity ?? 1,
    JSON.stringify(entry.detail ?? {}),
  ];
  if (tx) await tx.query(sql, params);
  else await queryOne(sql, params);
}

export async function setConnectionState(
  matchId: string,
  slot: PlayerSlot,
  state: 'ONLINE' | 'OFFLINE' | 'FORFEIT',
): Promise<void> {
  await queryOne('UPDATE match_players SET connection = $3 WHERE match_id = $1 AND slot = $2', [
    matchId,
    slot,
    state,
  ]);
}

// ---------------------------------------------------------------- read models

interface MatchRow {
  id: string;
  short_code: string;
  mode: string;
  status: string;
  entry_micros: string;
  commission_micros: string;
  prize_micros: string;
  rounds_to_win: number;
  max_rounds: number;
  current_round: number;
  is_ai_match: boolean;
  winner_slot: number | null;
  created_at: Date;
  finished_at: Date | null;
}

interface PlayerRow {
  slot: number;
  user_id: string | null;
  is_ai: boolean;
  display_name: string;
  avatar_url: string | null;
  level: number;
  rounds_won: number;
  connection: string;
}

interface RoundRow {
  round_no: number;
  status: string;
  winner_slot: number | null;
  win_reason: string | null;
  p1_reaction_ms: number | null;
  p2_reaction_ms: number | null;
  p1_false_start: boolean;
  p2_false_start: boolean;
}

export async function matchView(matchId: string, viewerUserId: string | null): Promise<MatchView | null> {
  const match = await queryOne<MatchRow>(
    `SELECT id, short_code, mode, status, entry_micros, commission_micros, prize_micros,
            rounds_to_win, max_rounds, current_round, is_ai_match, winner_slot,
            created_at, finished_at
       FROM matches WHERE id = $1`,
    [matchId],
  );
  if (!match) return null;

  const players = await query<PlayerRow>(
    `SELECT slot, user_id, is_ai, display_name, avatar_url, level, rounds_won, connection
       FROM match_players WHERE match_id = $1 ORDER BY slot`,
    [matchId],
  );

  const rounds = await query<RoundRow>(
    `SELECT round_no, status, winner_slot, win_reason,
            p1_reaction_ms, p2_reaction_ms, p1_false_start, p2_false_start
       FROM rounds WHERE match_id = $1 ORDER BY round_no`,
    [matchId],
  );

  return buildMatchView(match, players, rounds, viewerUserId);
}

export function buildMatchView(
  match: MatchRow,
  players: PlayerRow[],
  rounds: RoundRow[],
  viewerUserId: string | null,
): MatchView {
  return {
    id: match.id,
    shortCode: match.short_code,
    mode: match.mode as GameMode,
    status: match.status as MatchStatus,
    entryMicros: match.entry_micros,
    commissionMicros: match.commission_micros,
    prizeMicros: match.prize_micros,
    roundsToWin: match.rounds_to_win,
    maxRounds: match.max_rounds,
    currentRound: match.current_round,
    isAiMatch: match.is_ai_match,
    aiDisclosed: match.is_ai_match,
    winnerSlot: (match.winner_slot as PlayerSlot | null) ?? null,
    players: players.map((p) => ({
      slot: p.slot as PlayerSlot,
      userId: p.user_id,
      isAi: p.is_ai,
      isSelf: viewerUserId !== null && p.user_id === viewerUserId,
      displayName: p.display_name,
      avatarUrl: p.avatar_url,
      level: p.level,
      roundsWon: p.rounds_won,
      connection: p.connection as MatchView['players'][number]['connection'],
    })),
    rounds: rounds.map(
      (r): RoundView => ({
        roundNo: r.round_no,
        status: r.status as RoundStatus,
        winnerSlot: (r.winner_slot as PlayerSlot | null) ?? null,
        winReason: (r.win_reason as WinReason | null) ?? null,
        reactions: { 1: r.p1_reaction_ms, 2: r.p2_reaction_ms },
        falseStarts: { 1: r.p1_false_start, 2: r.p2_false_start },
      }),
    ),
    createdAt: match.created_at.toISOString(),
    finishedAt: match.finished_at?.toISOString() ?? null,
  };
}

/** Matches a user is currently a player in and that have not terminated. */
export async function activeMatchFor(userId: string): Promise<string | null> {
  const row = await queryOne<{ match_id: string }>(
    `SELECT mp.match_id
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = $1 AND m.status NOT IN ('MATCH_FINISHED','CANCELLED')
      ORDER BY mp.joined_at DESC
      LIMIT 1`,
    [userId],
  );
  return row?.match_id ?? null;
}

/** Non-terminal matches left behind by a crash or restart. */
export async function danglingMatches(): Promise<
  { id: string; mode: string; entry_micros: string; settled: boolean }[]
> {
  return query(
    `SELECT id, mode, entry_micros, settled
       FROM matches
      WHERE status NOT IN ('MATCH_FINISHED','CANCELLED')`,
  );
}
