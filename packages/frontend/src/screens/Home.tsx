import { useEffect, useState } from 'react';
import { levelFromXp } from '@cb/shared';
import { Avatar, Card, Empty, Pill, Stat, XpBar } from '../components/ui.js';
import { api } from '../lib/api.js';
import { compact, timeAgo, usd } from '../lib/format.js';
import { useStore } from '../state/store.js';

interface MatchSummary {
  id: string;
  mode: string;
  won: boolean;
  status: string;
  entryMicros: string;
  prizeMicros: string;
  score: { you: number; opponent: number };
  opponent: { displayName: string; avatarUrl: string | null; isAi: boolean };
  finishedAt: string | null;
  createdAt: string;
}

export function HomeScreen(): JSX.Element {
  const { user, progress, wallet, rank, config, navigate } = useStore();
  const [recent, setRecent] = useState<MatchSummary[]>([]);

  useEffect(() => {
    api
      .get<MatchSummary[]>('/api/matches?limit=5')
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  if (!user || !progress) {
    return (
      <div className="screen">
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      </div>
    );
  }

  const level = levelFromXp(BigInt(progress.xp));

  return (
    <div className="screen stack" style={{ gap: 16 }}>
      {/* ---- identity */}
      <Card>
        <div className="row">
          <Avatar name={user.displayName} url={user.photoUrl} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 7 }}>
              <h2 className="truncate">{user.displayName}</h2>
              <span className="level-badge">LV {progress.level}</span>
            </div>
            <div className="small dim">
              {rank ? `Rank #${rank}` : 'Unranked'} · {compact(progress.points)} pts
            </div>
          </div>
        </div>

        <div style={{ marginTop: 13 }}>
          <div className="row row--between tiny dim" style={{ marginBottom: 5 }}>
            <span>Level {progress.level}</span>
            <span>
              {level.isMax
                ? 'MAX'
                : `${compact(progress.xpIntoLevel)} / ${compact(progress.xpForNextLevel)} XP`}
            </span>
          </div>
          <XpBar progress={level.progress} />
        </div>
      </Card>

      {/* ---- balance */}
      {config?.modes.paid ? (
        <Card accent>
          <div className="row row--between">
            <div>
              <div className="tiny dim">Balance</div>
              <div style={{ fontSize: 27, fontWeight: 800 }}>
                {usd(wallet?.availableMicros ?? '0')}
              </div>
              {wallet && BigInt(wallet.lockedMicros) > 0n ? (
                <div className="tiny" style={{ color: 'var(--warn)' }}>
                  {usd(wallet.lockedMicros)} in play
                </div>
              ) : null}
            </div>
            <button type="button" className="btn btn--sm" onClick={() => navigate('wallet')}>
              Deposit
            </button>
          </div>
        </Card>
      ) : null}

      {/* ---- play */}
      <button
        type="button"
        className="btn btn--primary btn--block"
        style={{ padding: '18px', fontSize: 17, fontWeight: 750 }}
        onClick={() => navigate('play')}
      >
        ⚡ PLAY NOW
      </button>

      {/* ---- stats */}
      <div>
        <div className="section-title">Your record</div>
        <div className="stat-grid">
          <Stat value={progress.wins} label="Wins" />
          <Stat value={`${progress.winRate}%`} label="Win rate" />
          <Stat
            value={progress.bestReactionMs ? `${progress.bestReactionMs}` : '—'}
            label="Best ms"
          />
        </div>
      </div>

      {progress.currentStreak > 1 ? (
        <Card>
          <div className="row">
            <span style={{ fontSize: 22 }}>🔥</span>
            <div>
              <div style={{ fontWeight: 650 }}>{progress.currentStreak} win streak</div>
              <div className="small dim">Best: {progress.bestStreak}</div>
            </div>
          </div>
        </Card>
      ) : null}

      {/* ---- recent */}
      <div>
        <div className="row row--between">
          <div className="section-title">Recent matches</div>
          <button
            type="button"
            className="tiny"
            style={{ color: 'var(--accent)' }}
            onClick={() => navigate('history')}
          >
            See all
          </button>
        </div>

        {recent.length === 0 ? (
          <Card>
            <Empty icon="🎯" title="No matches yet" hint="Your results will show up here." />
          </Card>
        ) : (
          <Card flush>
            {recent.map((match) => (
              <div key={match.id} className="list-item">
                <Avatar
                  name={match.opponent.displayName}
                  url={match.opponent.avatarUrl}
                  size="sm"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: 600, fontSize: 14 }}>
                    {match.opponent.displayName}
                    {match.opponent.isAi ? ' 🤖' : ''}
                  </div>
                  <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    {timeAgo(match.finishedAt ?? match.createdAt)} ·{' '}
                    {match.score.you}–{match.score.opponent}
                  </div>
                </div>
                {match.status === 'CANCELLED' ? (
                  <Pill>Void</Pill>
                ) : match.won ? (
                  <Pill tone="win">
                    {match.mode === 'PAID' ? `+${usd(match.prizeMicros)}` : 'Won'}
                  </Pill>
                ) : (
                  <Pill tone="lose">
                    {match.mode === 'PAID' ? `−${usd(match.entryMicros)}` : 'Lost'}
                  </Pill>
                )}
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
