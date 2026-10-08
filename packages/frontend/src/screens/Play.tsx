/**
 * Mode selection and matchmaking.
 *
 * The paid tiers show the exact prize the server will pay, computed from the
 * same shared function the server settles with — so the number a player agrees
 * to is the number they get, not a client-side approximation of it.
 */

import { useEffect, useState } from 'react';
import { computeMatchEconomics } from '@cb/shared';
import { Banner, Card, Sheet } from '../components/ui.js';
import { usd } from '../lib/format.js';
import { haptic, openLink } from '../lib/telegram.js';
import { useStore } from '../state/store.js';

type Mode = 'FREE' | 'PAID' | 'DEMO';

export function PlayScreen(): JSX.Element {
  const { config, wallet, membership, queue, aiOffer, joinQueue, leaveQueue, acceptAi, navigate } =
    useStore();

  const [mode, setMode] = useState<Mode>('FREE');
  const [tier, setTier] = useState<string | null>(null);
  const [waitingMs, setWaitingMs] = useState(0);

  useEffect(() => {
    if (!queue?.active) {
      setWaitingMs(0);
      return;
    }
    const timer = window.setInterval(() => setWaitingMs(Date.now() - queue.since), 200);
    return () => window.clearInterval(timer);
  }, [queue?.active, queue?.since]);

  useEffect(() => {
    if (config?.paidTiersMicros.length && !tier) setTier(config.paidTiersMicros[0] ?? null);
  }, [config, tier]);

  if (!config) {
    return (
      <div className="screen">
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      </div>
    );
  }

  const available = BigInt(wallet?.availableMicros ?? '0');
  const membershipBlocked = Boolean(
    membership?.required && !membership.isMember && config.membership.requiredFor.includes(mode),
  );

  // ---------------------------------------------------------------- searching

  if (queue?.active) {
    const timeoutMs = config.matchmakingTimeoutMs;
    const progress = Math.min(1, waitingMs / timeoutMs);

    return (
      <div className="screen stack" style={{ gap: 20, paddingTop: 60 }}>
        <div className="center stack" style={{ gap: 14 }}>
          <div className="spinner" style={{ margin: '0 auto', width: 40, height: 40 }} />
          <h1>Finding an opponent</h1>
          <div className="dim">{(waitingMs / 1000).toFixed(1)}s</div>
          <div className="xp-bar" style={{ maxWidth: 220, margin: '0 auto', width: '100%' }}>
            <div className="xp-bar__fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="small faint">
            {progress < 1
              ? 'Matching you with a player of any level — the button treats everyone the same.'
              : 'Still looking…'}
          </div>
        </div>

        <button type="button" className="btn btn--ghost btn--block" onClick={() => void leaveQueue()}>
          Cancel search
        </button>

        {aiOffer ? (
          <Sheet onDismiss={() => void leaveQueue()}>
            <h2>No opponent found</h2>
            <p className="dim small" style={{ marginTop: 8 }}>
              {aiOffer.message}
            </p>
            <div className="stack" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => void acceptAi()}
              >
                Play the AI
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--block"
                onClick={() => void leaveQueue()}
              >
                Cancel {aiOffer.mode === 'PAID' ? '— full refund' : ''}
              </button>
            </div>
          </Sheet>
        ) : null}
      </div>
    );
  }

  // ---------------------------------------------------------------- picker

  const entryMicros = tier ? BigInt(tier) : 0n;
  const econ = entryMicros > 0n ? computeMatchEconomics(entryMicros, config.commissionBps) : null;
  const canAffordTier = entryMicros <= available;

  const canStart =
    !membershipBlocked &&
    (mode !== 'PAID' || (tier !== null && canAffordTier)) &&
    (mode === 'FREE' ? config.modes.free : mode === 'PAID' ? config.modes.paid : config.modes.demo);

  return (
    <div className="screen stack" style={{ gap: 16 }}>
      <h1>Play</h1>

      {config.maintenance.enabled ? (
        <Banner tone="warn">{config.maintenance.message}</Banner>
      ) : null}

      {/* ---- mode tabs */}
      <div className="scroll-x">
        {([
          { key: 'FREE' as const, label: '🎮 Free', on: config.modes.free },
          { key: 'PAID' as const, label: '💵 Paid', on: config.modes.paid },
          { key: 'DEMO' as const, label: '🧪 Demo', on: config.modes.demo },
        ]).map((option) => (
          <button
            key={option.key}
            type="button"
            className={`btn btn--sm${mode === option.key ? ' btn--primary' : ''}`}
            disabled={!option.on}
            onClick={() => {
              haptic.select();
              setMode(option.key);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* ---- mode detail */}
      {mode === 'FREE' ? (
        <Card>
          <h3>Free match</h3>
          <p className="small dim" style={{ marginTop: 6 }}>
            No money involved. Play for XP, points, your level and your place on the leaderboard.
          </p>
        </Card>
      ) : null}

      {mode === 'DEMO' ? (
        <Card>
          <h3>Demo</h3>
          <p className="small dim" style={{ marginTop: 6 }}>
            The real game against our AI — same rules, same timing, same server. Nothing is
            deducted, nothing is won, and it does not affect your record.
          </p>
        </Card>
      ) : null}

      {mode === 'PAID' ? (
        <>
          <div className="row row--between">
            <div className="section-title">Entry amount</div>
            <div className="small dim">Balance {usd(available)}</div>
          </div>

          <div className="tier-grid">
            {config.paidTiersMicros.map((value) => {
              const amount = BigInt(value);
              const tierEcon = computeMatchEconomics(amount, config.commissionBps);
              const affordable = amount <= available;
              return (
                <button
                  key={value}
                  type="button"
                  className={`tier${tier === value ? ' tier--selected' : ''}${
                    affordable ? '' : ' tier--locked'
                  }`}
                  onClick={() => {
                    haptic.select();
                    setTier(value);
                  }}
                >
                  <div className="tier__amount">{usd(amount, 0)}</div>
                  <div className="tier__prize">Win {usd(tierEcon.prizeMicros)}</div>
                </button>
              );
            })}
          </div>

          {econ ? (
            <Card>
              <div className="section-title" style={{ margin: '0 0 8px' }}>
                Where your money goes
              </div>
              <Line label="Your entry" value={usd(econ.entryMicros)} />
              <Line
                label={`Platform fee (${config.commissionBps / 100}%)`}
                value={`−${usd(econ.commissionPerPlayerMicros)}`}
                dim
              />
              <Line label="Opponent's entry" value={usd(econ.entryMicros)} dim />
              <Line
                label="Their fee"
                value={`−${usd(econ.commissionPerPlayerMicros)}`}
                dim
              />
              <div
                style={{
                  borderTop: '1px solid var(--border)',
                  marginTop: 8,
                  paddingTop: 8,
                }}
              >
                <Line label="Champion receives" value={usd(econ.prizeMicros)} strong />
                <Line
                  label="Your net profit if you win"
                  value={`+${usd(econ.prizeMicros - econ.entryMicros)}`}
                  accent
                />
              </div>
            </Card>
          ) : null}

          {!canAffordTier ? (
            <Banner tone="warn">
              Not enough balance for this entry.{' '}
              <button
                type="button"
                style={{ color: 'var(--accent)', fontWeight: 650 }}
                onClick={() => navigate('wallet')}
              >
                Deposit USDT
              </button>
            </Banner>
          ) : null}

          {config.paidAiPolicy === 'DISABLED' || config.paidAiPolicy === 'REFUND_AND_OFFER' ? (
            <div className="small faint">
              Paid matches are played against real people only. If no opponent is found, your entry
              is returned in full.
            </div>
          ) : (
            <Banner tone="info">
              If no player is found, you may be offered a match against the house AI. It will be
              clearly labelled, and you can always decline for a full refund.
            </Banner>
          )}
        </>
      ) : null}

      {membershipBlocked ? (
        <Banner tone="warn">
          Join our Telegram channel to play this mode.{' '}
          <button
            type="button"
            style={{ color: 'var(--accent)', fontWeight: 650 }}
            onClick={() => openLink(config.membership.inviteUrl)}
          >
            Join now
          </button>
        </Banner>
      ) : null}

      <button
        type="button"
        className="btn btn--primary btn--block"
        style={{ padding: 17, fontSize: 16 }}
        disabled={!canStart}
        onClick={() => {
          haptic.tap();
          void joinQueue(mode, mode === 'PAID' && tier ? tier : undefined);
        }}
      >
        {mode === 'PAID' && econ
          ? `Enter for ${usd(econ.entryMicros)}`
          : mode === 'DEMO'
            ? 'Start demo'
            : 'Find a match'}
      </button>

      <Card>
        <h3>How a round works</h3>
        <ol className="small dim" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.75 }}>
          <li>A 3-2-1 countdown plays.</li>
          <li>Then you wait — GO appears at a moment you cannot predict.</li>
          <li>Tap the instant it does. Tapping early loses the round.</li>
          <li>First to win {config.roundsToWin} of {config.maxRounds} rounds is champion.</li>
        </ol>
        <p className="small faint" style={{ marginTop: 10 }}>
          Timing is measured on our servers and adjusted for your network latency, so a slower
          connection does not cost you a round.
        </p>
      </Card>
    </div>
  );
}

function Line({
  label,
  value,
  dim,
  strong,
  accent,
}: {
  label: string;
  value: string;
  dim?: boolean;
  strong?: boolean;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="row row--between" style={{ padding: '3px 0' }}>
      <span className={`small${dim ? ' faint' : ' dim'}`}>{label}</span>
      <span
        className="mono"
        style={{
          fontWeight: strong || accent ? 700 : 550,
          fontSize: strong ? 16 : 14,
          color: accent ? 'var(--accent)' : dim ? 'var(--text-faint)' : 'var(--text)',
        }}
      >
        {value}
      </span>
    </div>
  );
}
