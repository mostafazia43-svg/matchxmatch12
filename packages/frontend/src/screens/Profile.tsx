import { levelFromXp } from '@cb/shared';
import { Avatar, Card, ConnectionDot, Pill, Stat, XpBar } from '../components/ui.js';
import { compact, usd } from '../lib/format.js';
import { openLink } from '../lib/telegram.js';
import { useStore } from '../state/store.js';

export function ProfileScreen(): JSX.Element {
  const { user, progress, wallet, rank, config, connection, rttMs, membership, navigate } =
    useStore();

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
      <div className="center stack" style={{ gap: 10, paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Avatar name={user.displayName} url={user.photoUrl} size="lg" />
        </div>
        <div>
          <h1>{user.displayName}</h1>
          {user.username ? <div className="dim small">@{user.username}</div> : null}
        </div>
        <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
          <Pill tone="accent">Level {progress.level}</Pill>
          {rank ? <Pill>Rank #{rank}</Pill> : null}
          {user.isAdmin ? <Pill tone="paid">Admin</Pill> : null}
        </div>
      </div>

      <Card>
        <div className="row row--between tiny dim" style={{ marginBottom: 6 }}>
          <span>{compact(progress.xp)} XP total</span>
          <span>
            {level.isMax
              ? 'MAX LEVEL'
              : `${compact(progress.xpIntoLevel)} / ${compact(progress.xpForNextLevel)} to level ${
                  progress.level + 1
                }`}
          </span>
        </div>
        <XpBar progress={level.progress} />
      </Card>

      <div>
        <div className="section-title">Overall</div>
        <div className="stat-grid">
          <Stat value={progress.totalMatches} label="Matches" />
          <Stat value={progress.wins} label="Wins" />
          <Stat value={`${progress.winRate}%`} label="Win rate" />
        </div>
      </div>

      <div>
        <div className="section-title">Speed</div>
        <div className="stat-grid">
          <Stat
            value={progress.bestReactionMs ? `${progress.bestReactionMs}ms` : '—'}
            label="Best reaction"
          />
          <Stat value={progress.currentStreak} label="Streak" />
          <Stat value={progress.bestStreak} label="Best streak" />
        </div>
      </div>

      <div>
        <div className="section-title">By mode</div>
        <div className="stack" style={{ gap: 8 }}>
          <Card>
            <div className="row row--between">
              <span className="small dim">🎮 Free matches</span>
              <span className="mono small">
                {progress.freeWins}W / {progress.freeMatches - progress.freeWins}L
              </span>
            </div>
          </Card>
          <Card>
            <div className="row row--between">
              <span className="small dim">💵 Paid matches</span>
              <span className="mono small">
                {progress.paidWins}W / {progress.paidMatches - progress.paidWins}L
              </span>
            </div>
          </Card>
        </div>
      </div>

      {config?.modes.paid ? (
        <Card>
          <div className="row row--between">
            <div>
              <div className="tiny dim">Wallet balance</div>
              <div style={{ fontSize: 21, fontWeight: 750 }}>
                {usd(wallet?.availableMicros ?? '0')}
              </div>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => navigate('wallet')}>
              Manage
            </button>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="row row--between">
          <span className="small dim">Connection</span>
          <ConnectionDot status={connection} rttMs={rttMs} />
        </div>
        <div className="tiny faint" style={{ marginTop: 8, textTransform: 'none', letterSpacing: 0 }}>
          Your latency is measured continuously and compensated for during rounds.
        </div>
      </Card>

      {membership?.required && !membership.isMember ? (
        <button
          type="button"
          className="btn btn--block"
          onClick={() => openLink(membership.inviteUrl)}
        >
          Join our Telegram channel
        </button>
      ) : null}

      {user.isAdmin ? (
        <button type="button" className="btn btn--block" onClick={() => navigate('admin')}>
          ⚙️ Admin panel
        </button>
      ) : null}

      <div className="center small faint" style={{ paddingTop: 6 }}>
        Click Battle · Signed in with Telegram
      </div>
    </div>
  );
}
