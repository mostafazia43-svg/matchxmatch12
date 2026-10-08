import { useEffect } from 'react';
import { Avatar, Card, Empty } from '../components/ui.js';
import { compact } from '../lib/format.js';
import { useStore } from '../state/store.js';

export function LeaderboardScreen(): JSX.Element {
  const { leaderboard, loadLeaderboard } = useStore();

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  if (!leaderboard) {
    return (
      <div className="screen">
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      </div>
    );
  }

  const { entries, me } = leaderboard;
  const meInTop = entries.some((entry) => entry.isSelf);

  return (
    <div className="screen stack" style={{ gap: 14 }}>
      <h1>Leaderboard</h1>

      {me ? (
        <Card accent>
          <div className="row">
            <div className={`rank rank--${me.rank <= 3 ? me.rank : ''}`}>#{me.rank}</div>
            <Avatar name={me.displayName} url={me.photoUrl} size="sm" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 650 }}>
                You
              </div>
              <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                Level {me.level} · {me.wins}W / {me.losses}L · {me.winRate}%
              </div>
            </div>
            <div className="mono" style={{ fontWeight: 700 }}>
              {compact(me.points)}
            </div>
          </div>
        </Card>
      ) : null}

      {entries.length === 0 ? (
        <Card>
          <Empty icon="🏆" title="No ranked players yet" hint="Win a match to claim the top spot." />
        </Card>
      ) : (
        <Card flush>
          {entries.map((entry) => (
            <div
              key={entry.userId}
              className="list-item"
              style={
                entry.isSelf && !meInTop
                  ? undefined
                  : entry.isSelf
                    ? { background: 'rgba(198, 242, 78, 0.05)' }
                    : undefined
              }
            >
              <div className={`rank${entry.rank <= 3 ? ` rank--${entry.rank}` : ''}`}>
                {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : entry.rank}
              </div>
              <Avatar name={entry.displayName} url={entry.photoUrl} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600, fontSize: 14 }}>
                  {entry.displayName}
                  {entry.isSelf ? ' (you)' : ''}
                </div>
                <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  Lv {entry.level} · {entry.winRate}% win rate
                  {entry.bestReactionMs ? ` · ${entry.bestReactionMs}ms best` : ''}
                </div>
              </div>
              <div className="mono" style={{ fontWeight: 700, fontSize: 14 }}>
                {compact(entry.points)}
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="small faint center">
        Ranked by points. Paid matches award more than free ones.
      </div>
    </div>
  );
}
