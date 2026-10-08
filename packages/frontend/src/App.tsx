import { useEffect } from 'react';
import { Banner } from './components/ui.js';
import { GameScreen } from './screens/Game.js';
import { HomeScreen } from './screens/Home.js';
import { PlayScreen } from './screens/Play.js';
import { WalletScreen } from './screens/Wallet.js';
import { LeaderboardScreen } from './screens/Leaderboard.js';
import { HistoryScreen } from './screens/History.js';
import { ProfileScreen } from './screens/Profile.js';
import { AdminScreen } from './screens/Admin.js';
import { setBackButton } from './lib/telegram.js';
import { useStore, type Screen } from './state/store.js';

const NAV: { key: Screen; icon: string; label: string }[] = [
  { key: 'home', icon: '🏠', label: 'Home' },
  { key: 'play', icon: '⚡', label: 'Play' },
  { key: 'leaderboard', icon: '🏆', label: 'Ranks' },
  { key: 'history', icon: '📜', label: 'History' },
  { key: 'wallet', icon: '💰', label: 'Wallet' },
  { key: 'profile', icon: '👤', label: 'Profile' },
];

export function App(): JSX.Element {
  const { ready, bootError, screen, navigate, toasts, dismissToast, match } = useStore();

  // A live match takes over the screen — there is nowhere else to be during one.
  useEffect(() => {
    if (match && screen !== 'game') navigate('game');
  }, [match, screen, navigate]);

  // Telegram's native back button. Deliberately not shown during a match:
  // there is no "back" from a live round, only forfeiting.
  useEffect(() => {
    const showBack = screen !== 'home' && screen !== 'game';
    setBackButton(showBack ? () => navigate('home') : null);
    return () => setBackButton(null);
  }, [screen, navigate]);

  if (!ready) {
    return (
      <div className="app">
        <div className="screen center" style={{ display: 'grid', placeContent: 'center', gap: 16 }}>
          <div style={{ fontSize: 44 }}>⚡</div>
          <div className="spinner" style={{ margin: '0 auto' }} />
          <div className="dim small">Connecting…</div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="app">
        <div className="screen stack" style={{ justifyContent: 'center', gap: 16 }}>
          <div className="center" style={{ fontSize: 44 }}>
            ⚠️
          </div>
          <h1 className="center">Can't start</h1>
          <Banner tone="error">{bootError}</Banner>
          <p className="small faint center">
            Open Click Battle from the Telegram bot. If this keeps happening, close and reopen the
            app.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const inMatch = screen === 'game' && match;

  return (
    <div className="app">
      {screen === 'home' ? <HomeScreen /> : null}
      {screen === 'play' ? <PlayScreen /> : null}
      {screen === 'game' ? <GameScreen /> : null}
      {screen === 'leaderboard' ? <LeaderboardScreen /> : null}
      {screen === 'history' ? <HistoryScreen /> : null}
      {screen === 'wallet' ? <WalletScreen /> : null}
      {screen === 'profile' ? <ProfileScreen /> : null}
      {screen === 'admin' ? <AdminScreen /> : null}

      {toasts.length > 0 ? (
        <div className="toast">
          {toasts.map((item) => (
            <div
              key={item.id}
              className={`banner banner--${item.tone === 'warn' ? 'warn' : item.tone}`}
              style={{ marginBottom: 6 }}
              onClick={() => dismissToast(item.id)}
            >
              {item.text}
            </div>
          ))}
        </div>
      ) : null}

      {/* The nav is hidden mid-match: leaving would forfeit, so don't offer it. */}
      {!inMatch ? (
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav__item${screen === item.key ? ' nav__item--active' : ''}`}
              onClick={() => navigate(item.key)}
            >
              <span className="nav__icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      ) : null}

    </div>
  );
}
