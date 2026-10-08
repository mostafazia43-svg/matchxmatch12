import { useEffect, useState } from 'react';
import { Avatar, Card, Empty, Pill } from '../components/ui.js';
import { api } from '../lib/api.js';
import { timeAgo, usd } from '../lib/format.js';

interface MatchSummary {
  id: string;
  shortCode: string;
  mode: string;
  status: string;
  entryMicros: string;
  prizeMicros: string;
  won: boolean;
  score: { you: number; opponent: number };
  opponent: { displayName: string; avatarUrl: string | null; isAi: boolean };
  createdAt: string;
  finishedAt: string | null;
}

type Filter = 'ALL' | 'FREE' | 'PAID' | 'DEMO';

export function HistoryScreen(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);

  useEffect(() => {
    setMatches(null);
    const query = filter === 'ALL' ? '' : `&mode=${filter}`;
    api
      .get<MatchSummary[]>(`/api/matches?limit=50${query}`)
      .then(setMatches)
      .catch(() => setMatches([]));
  }, [filter]);

  return (
    <div className="screen stack" style={{ gap: 14 }}>
      <h1>History</h1>

      <div className="scroll-x">
        {(['ALL', 'FREE', 'PAID', 'DEMO'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`btn btn--sm${filter === key ? ' btn--primary' : ''}`}
            onClick={() => setFilter(key)}
          >
            {key === 'ALL' ? 'All' : key.charAt(0) + key.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {matches === null ? (
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      ) : matches.length === 0 ? (
        <Card>
          <Empty icon="📜" title="Nothing here yet" hint="Play a match to start your history." />
        </Card>
      ) : (
        <Card flush>
          {matches.map((match) => (
            <div key={match.id} className="list-item">
              <Avatar name={match.opponent.displayName} url={match.opponent.avatarUrl} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="truncate" style={{ fontWeight: 600, fontSize: 14 }}>
                    {match.opponent.displayName}
                    {match.opponent.isAi ? ' 🤖' : ''}
                  </span>
                </div>
                <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {match.mode} · {match.score.you}–{match.score.opponent} ·{' '}
                  {timeAgo(match.finishedAt ?? match.createdAt)} · #{match.shortCode}
                </div>
              </div>
              {match.status === 'CANCELLED' ? (
                <Pill>Void</Pill>
              ) : match.status !== 'MATCH_FINISHED' ? (
                <Pill tone="accent">Live</Pill>
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
  );
}
