/**
 * The match screen.
 *
 * This is the one screen where every millisecond of render cost is real, so it
 * is deliberately plain: no layout thrash between phases, no transition on the
 * GO state, and the tap handler does nothing but send.
 *
 * It is also the screen where it matters most that the client decides nothing.
 * The phase shown here is whatever the server last said; the reaction time is
 * whatever the server measured. Nothing below computes a winner.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchView, PlayerSlot, ServerEvent } from '@cb/shared';
import { WIN_REASON_LABEL } from '@cb/shared';
import { Avatar, ConnectionDot, Pill } from '../components/ui.js';
import { usd } from '../lib/format.js';
import { socket } from '../lib/socket.js';
import { haptic } from '../lib/telegram.js';
import { useStore } from '../state/store.js';

type Phase = 'intro' | 'countdown' | 'armed' | 'live' | 'result' | 'between' | 'over';

interface RoundResultState {
  winnerSlot: PlayerSlot | null;
  reason: string;
  yourMs: number | null;
  theirMs: number | null;
  youFalseStarted: boolean;
}

export function GameScreen(): JSX.Element {
  const { match: initialMatch, user, connection, rttMs, onServerEvent, clearMatch } = useStore();

  const [match, setMatch] = useState<MatchView | null>(initialMatch);
  const [phase, setPhase] = useState<Phase>('intro');
  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const [roundNo, setRoundNo] = useState(1);
  const [score, setScore] = useState<Record<PlayerSlot, number>>({ 1: 0, 2: 0 });
  const [reactionMs, setReactionMs] = useState<number | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [roundResult, setRoundResult] = useState<RoundResultState | null>(null);
  const [outcome, setOutcome] = useState<
    { won: boolean; prizeMicros: string; xpGained: string; levelUp: number | null } | null
  >(null);
  const [opponentAway, setOpponentAway] = useState(false);

  // Kept in a ref so the tap handler never goes stale between renders.
  const phaseRef = useRef<Phase>('intro');
  const roundRef = useRef(1);
  const clickedRef = useRef(false);

  const mySlot: PlayerSlot =
    match?.players.find((player) => player.userId === user?.id)?.slot ?? 1;
  const theirSlot: PlayerSlot = mySlot === 1 ? 2 : 1;
  const me = match?.players.find((player) => player.slot === mySlot);
  const them = match?.players.find((player) => player.slot === theirSlot);

  const setPhaseBoth = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    if (initialMatch) setMatch(initialMatch);
  }, [initialMatch]);

  useEffect(() => {
    if (match) socket.send({ t: 'MATCH_SUBSCRIBE', matchId: match.id });
  }, [match?.id]);

  useEffect(
    () =>
      onServerEvent((event: ServerEvent) => {
        switch (event.t) {
          case 'COUNTDOWN_START':
            setRoundNo(event.roundNo);
            roundRef.current = event.roundNo;
            clickedRef.current = false;
            setReactionMs(null);
            setFault(null);
            setRoundResult(null);
            setCountdownValue(null);
            setPhaseBoth('countdown');
            break;

          case 'COUNTDOWN_TICK':
            setCountdownValue(event.value);
            haptic.select();
            break;

          case 'ROUND_ARMED':
            setCountdownValue(null);
            setPhaseBoth('armed');
            break;

          case 'ROUND_START':
            // GO. Nothing between this and the button turning green.
            setPhaseBoth('live');
            break;

          case 'CLICK_ACCEPTED':
            setReactionMs(event.reactionMs);
            haptic.tap();
            break;

          case 'CLICK_REJECTED':
            clickedRef.current = true;
            setFault(
              event.reason === 'EARLY'
                ? 'Too early — you jumped the start.'
                : event.reason === 'TOO_FAST'
                  ? 'That was faster than humanly possible.'
                  : 'Click not accepted.',
            );
            haptic.error();
            break;

          case 'ROUND_RESULT': {
            setScore(event.score);
            setRoundResult({
              winnerSlot: event.round.winnerSlot,
              reason: event.round.winReason ?? '',
              yourMs: event.round.reactions[mySlot],
              theirMs: event.round.reactions[theirSlot],
              youFalseStarted: event.round.falseStarts[mySlot],
            });
            setPhaseBoth('result');
            if (event.round.winnerSlot === mySlot) haptic.success();
            else if (event.round.winnerSlot !== null) haptic.error();
            break;
          }

          case 'NEXT_ROUND':
            setPhaseBoth('between');
            break;

          case 'MATCH_RESULT':
            setMatch(event.match);
            setOutcome({
              won: event.youWon,
              prizeMicros: event.prizeMicros,
              xpGained: event.xpGained,
              levelUp: event.levelUp,
            });
            setPhaseBoth('over');
            if (event.youWon) haptic.success();
            else haptic.error();
            break;

          case 'PLAYER_DISCONNECTED':
            if (event.slot !== mySlot) setOpponentAway(true);
            break;

          case 'PLAYER_RECONNECTED':
            if (event.slot !== mySlot) setOpponentAway(false);
            break;

          default:
            break;
        }
      }),
    [mySlot, theirSlot, onServerEvent, setPhaseBoth],
  );

  /**
   * The tap.
   *
   * Sent unconditionally whenever a round is in play — including during the
   * ARMED phase, where it will (correctly) be judged a false start. Filtering
   * early taps client-side would hide the mistake from the player and give a
   * modified client an advantage over an honest one.
   */
  const onTap = useCallback(() => {
    const current = phaseRef.current;
    if (current !== 'live' && current !== 'armed') return;
    if (clickedRef.current) return;
    clickedRef.current = true;
    if (match) socket.click(match.id, roundRef.current);
  }, [match]);

  if (!match) {
    return (
      <div className="game">
        <div className="arena">
          <div className="spinner" />
          <div className="dim small">Loading match…</div>
        </div>
      </div>
    );
  }

  const targetClass =
    phase === 'live'
      ? 'tap-target tap-target--live'
      : phase === 'armed'
        ? `tap-target tap-target--armed${fault ? ' tap-target--fault' : ''}`
        : phase === 'result' || phase === 'between' || phase === 'over'
          ? 'tap-target tap-target--done'
          : 'tap-target tap-target--wait';

  return (
    <div className="game">
      <header className="game__header">
        <div className="row" style={{ gap: 6 }}>
          <Pill tone={match.mode === 'PAID' ? 'paid' : undefined}>
            {match.mode === 'PAID' ? `${usd(match.entryMicros)} match` : match.mode}
          </Pill>
          {match.mode === 'PAID' ? <Pill tone="accent">Win {usd(match.prizeMicros)}</Pill> : null}
        </div>
        <ConnectionDot status={connection} rttMs={rttMs} />
      </header>

      <div className="versus">
        <div className="versus__side">
          <Avatar name={me?.displayName ?? 'You'} url={me?.avatarUrl} />
          <div className="versus__name">You</div>
          <Pips won={score[mySlot]} total={match.roundsToWin} />
        </div>

        <div className="versus__vs">
          <div>VS</div>
          <div className="tiny" style={{ marginTop: 6, color: 'var(--text-faint)' }}>
            R{roundNo}
          </div>
        </div>

        <div className="versus__side">
          <Avatar name={them?.displayName ?? 'Opponent'} url={them?.avatarUrl} />
          <div className="versus__name">
            {them?.displayName ?? 'Opponent'}
            {them?.isAi ? ' 🤖' : ''}
          </div>
          <Pips won={score[theirSlot]} total={match.roundsToWin} />
        </div>
      </div>

      {opponentAway && phase !== 'over' ? (
        <div className="banner banner--warn" style={{ marginBottom: 10 }}>
          Your opponent lost connection. They forfeit if they don't return shortly.
        </div>
      ) : null}

      <div className="arena">
        {phase === 'over' && outcome ? (
          <MatchOver
            outcome={outcome}
            isPaid={match.mode === 'PAID'}
            onDone={clearMatch}
          />
        ) : (
          <>
            <button
              type="button"
              className={targetClass}
              onPointerDown={onTap}
              disabled={phase === 'intro' || phase === 'result' || phase === 'between'}
            >
              {renderTargetContent({ phase, countdownValue, reactionMs, roundResult, mySlot })}
            </button>

            <div className="center" style={{ minHeight: 46 }}>
              {renderCaption({ phase, fault, roundResult, mySlot, reactionMs, countdownValue })}
            </div>
          </>
        )}
      </div>

      {phase !== 'over' ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          style={{ alignSelf: 'center' }}
          onClick={() => {
            if (confirm('Forfeit this match? Your opponent wins.')) {
              socket.send({ t: 'FORFEIT', matchId: match.id });
            }
          }}
        >
          Forfeit
        </button>
      ) : null}
    </div>
  );
}

function Pips({ won, total }: { won: number; total: number }): JSX.Element {
  return (
    <div className="pips">
      {Array.from({ length: total }, (_, index) => (
        <div key={index} className={`pip${index < won ? ' pip--won' : ''}`} />
      ))}
    </div>
  );
}

function renderTargetContent(args: {
  phase: Phase;
  countdownValue: number | null;
  reactionMs: number | null;
  roundResult: RoundResultState | null;
  mySlot: PlayerSlot;
}): JSX.Element | string {
  const { phase, countdownValue, reactionMs, roundResult, mySlot } = args;

  switch (phase) {
    case 'intro':
      return 'GET READY';
    case 'countdown':
      return countdownValue !== null ? (
        <span className="countdown-number" key={countdownValue}>
          {countdownValue}
        </span>
      ) : (
        'READY'
      );
    case 'armed':
      return 'WAIT…';
    case 'live':
      return 'GO';
    case 'result':
      if (!roundResult) return '—';
      if (roundResult.winnerSlot === mySlot) return 'ROUND WON';
      if (roundResult.winnerSlot === null) return 'TIE';
      return 'ROUND LOST';
    case 'between':
      return reactionMs !== null ? `${reactionMs} ms` : 'NEXT ROUND';
    default:
      return '—';
  }
}

function renderCaption(args: {
  phase: Phase;
  fault: string | null;
  roundResult: RoundResultState | null;
  mySlot: PlayerSlot;
  reactionMs: number | null;
  countdownValue: number | null;
}): JSX.Element | null {
  const { phase, fault, roundResult, mySlot, reactionMs } = args;

  if (fault && (phase === 'armed' || phase === 'result')) {
    return <div style={{ color: 'var(--lose)', fontWeight: 650 }}>{fault}</div>;
  }

  switch (phase) {
    case 'intro':
      return <div className="dim small">Match starting…</div>;
    case 'countdown':
      return <div className="dim small">Don't tap yet.</div>;
    case 'armed':
      return (
        <div style={{ color: 'var(--warn)', fontWeight: 650 }}>
          GO could come at any moment. Tapping early loses the round.
        </div>
      );
    case 'live':
      return reactionMs !== null ? (
        <div className="reaction-readout" style={{ color: 'var(--accent)' }}>
          {reactionMs} ms
        </div>
      ) : (
        <div className="dim small">TAP NOW</div>
      );
    case 'result':
      if (!roundResult) return null;
      return (
        <div className="stack" style={{ gap: 4, alignItems: 'center' }}>
          <div className="small dim">
            {roundResult.winnerSlot === mySlot
              ? WIN_REASON_LABEL[roundResult.reason] ?? 'You won the round'
              : roundResult.winnerSlot === null
                ? 'Tied round — replaying'
                : 'Opponent took the round'}
          </div>
          <div className="row mono small" style={{ gap: 14 }}>
            <span>You {roundResult.yourMs !== null ? `${roundResult.yourMs}ms` : '—'}</span>
            <span className="faint">vs</span>
            <span>Them {roundResult.theirMs !== null ? `${roundResult.theirMs}ms` : '—'}</span>
          </div>
        </div>
      );
    case 'between':
      return <div className="dim small">Next round starting…</div>;
    default:
      return null;
  }
}

function MatchOver({
  outcome,
  isPaid,
  onDone,
}: {
  outcome: { won: boolean; prizeMicros: string; xpGained: string; levelUp: number | null };
  isPaid: boolean;
  onDone: () => void;
}): JSX.Element {
  const prize = BigInt(outcome.prizeMicros || '0');

  return (
    <div className="stack center" style={{ gap: 16, width: '100%' }}>
      <div style={{ fontSize: 64 }}>{outcome.won ? '🏆' : '💥'}</div>
      <h1 style={{ color: outcome.won ? 'var(--accent)' : 'var(--text-dim)' }}>
        {outcome.won ? 'CHAMPION' : 'DEFEATED'}
      </h1>

      {isPaid && prize > 0n ? (
        <div className="card card--accent" style={{ width: '100%' }}>
          <div className="tiny dim">Prize credited</div>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--accent)' }}>{usd(prize)}</div>
        </div>
      ) : null}

      <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
        {Number(outcome.xpGained) > 0 ? <Pill tone="accent">+{outcome.xpGained} XP</Pill> : null}
        {outcome.levelUp ? <Pill tone="win">Level {outcome.levelUp}!</Pill> : null}
      </div>

      <button type="button" className="btn btn--primary btn--block" onClick={onDone}>
        Continue
      </button>
    </div>
  );
}
