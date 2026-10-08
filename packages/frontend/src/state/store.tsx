/**
 * Application state.
 *
 * A single context rather than a state library: the app has one user, one
 * wallet, one live match and a handful of screens. The important rule is that
 * nothing here computes an outcome — every field is either a copy of what the
 * server said or purely presentational.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  LeaderboardEntry,
  MatchView,
  PlayerProgress,
  PublicConfig,
  PublicUser,
  ServerEvent,
  WalletSummary,
} from '@cb/shared';
import { ApiError, api, getToken, setToken } from '../lib/api.js';
import { socket, type ConnectionStatus } from '../lib/socket.js';
import { haptic, initData, isInsideTelegram } from '../lib/telegram.js';

export type Screen = 'home' | 'play' | 'game' | 'leaderboard' | 'history' | 'wallet' | 'profile' | 'admin';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface AiOffer {
  mode: string;
  entryMicros: string;
  message: string;
  expiresAt: number;
}

interface MeResponse {
  user: PublicUser;
  progress: PlayerProgress;
  wallet: WalletSummary;
  rank: number | null;
  membership: { required: boolean; isMember: boolean; inviteUrl: string };
  activeMatchId: string | null;
}

interface AuthResponse {
  token: string;
  user: PublicUser;
  config: PublicConfig;
  isNewUser: boolean;
}

interface StoreValue {
  ready: boolean;
  bootError: string | null;
  user: PublicUser | null;
  progress: PlayerProgress | null;
  wallet: WalletSummary | null;
  rank: number | null;
  membership: MeResponse['membership'] | null;
  config: PublicConfig | null;

  screen: Screen;
  navigate(screen: Screen): void;

  connection: ConnectionStatus;
  rttMs: number;

  match: MatchView | null;
  queue: { active: boolean; mode: string; since: number } | null;
  aiOffer: AiOffer | null;

  toasts: Toast[];
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;

  refresh(): Promise<void>;
  leaderboard: { entries: LeaderboardEntry[]; me: LeaderboardEntry | null } | null;
  loadLeaderboard(): Promise<void>;

  joinQueue(mode: string, entryMicros?: string): Promise<void>;
  leaveQueue(): Promise<void>;
  acceptAi(): Promise<void>;
  clearMatch(): void;

  onServerEvent(listener: (event: ServerEvent) => void): () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}

export function StoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [progress, setProgress] = useState<PlayerProgress | null>(null);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  const [membership, setMembership] = useState<MeResponse['membership'] | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);

  const [screen, setScreen] = useState<Screen>('home');
  const [connection, setConnection] = useState<ConnectionStatus>('idle');
  const [rttMs, setRttMs] = useState(0);

  const [match, setMatch] = useState<MatchView | null>(null);
  const [queue, setQueue] = useState<StoreValue['queue']>(null);
  const [aiOffer, setAiOffer] = useState<AiOffer | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leaderboard, setLeaderboard] = useState<StoreValue['leaderboard']>(null);

  const toastId = useRef(0);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, tone, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4_000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const navigate = useCallback((next: Screen) => {
    setScreen(next);
    window.scrollTo(0, 0);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>('/api/me');
      setUser(me.user);
      setProgress(me.progress);
      setWallet(me.wallet);
      setRank(me.rank);
      setMembership(me.membership);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setBootError('Session expired.');
    }
  }, []);

  const loadLeaderboard = useCallback(async () => {
    try {
      const data = await api.get<{ entries: LeaderboardEntry[]; me: LeaderboardEntry | null }>(
        '/api/leaderboard?limit=100',
      );
      setLeaderboard(data);
    } catch {
      toast('Could not load the leaderboard.', 'error');
    }
  }, [toast]);

  // ---------------------------------------------------------------- boot

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      try {
        if (!isInsideTelegram()) {
          // Development fallback. In production this endpoint is disabled
          // server-side, so this path simply fails with a clear message.
          const auth = await api.post<AuthResponse>('/api/auth/dev', {
            telegramId: String(Math.floor(Math.random() * 1_000_000) + 100_000),
            name: `Dev${Math.floor(Math.random() * 900) + 100}`,
          });
          if (cancelled) return;
          setToken(auth.token);
          setUser(auth.user);
          setConfig(auth.config);
        } else {
          const auth = await api.post<AuthResponse>('/api/auth/telegram', { initData: initData() });
          if (cancelled) return;
          setToken(auth.token);
          setUser(auth.user);
          setConfig(auth.config);
          if (auth.isNewUser) toast('Welcome to Click Battle!', 'success');
        }

        await refresh();
        if (cancelled) return;

        const token = getToken();
        if (token) socket.connect(token);
        setReady(true);
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof ApiError
            ? error.message
            : 'Could not reach Click Battle. Please try again.';
        setBootError(message);
        setReady(true);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [refresh, toast]);

  // ---------------------------------------------------------------- socket

  useEffect(() => socket.onStatus((status, rtt) => {
    setConnection(status);
    setRttMs(rtt);
  }), []);

  useEffect(
    () =>
      socket.onEvent((event) => {
        for (const listener of listeners.current) listener(event);

        switch (event.t) {
          case 'MATCH_FOUND':
            setQueue(null);
            setAiOffer(null);
            setMatch(event.match);
            setScreen('game');
            haptic.success();
            break;

          case 'MATCH_RESULT':
            setMatch(event.match);
            void refresh();
            break;

          case 'MATCH_CANCELLED':
            setMatch(null);
            setScreen('home');
            toast(event.reason, 'warn');
            void refresh();
            break;

          case 'QUEUE_STATE':
            if (event.state === 'WAITING') {
              setQueue({ active: true, mode: event.mode, since: Date.now() });
            } else {
              setQueue(null);
              setAiOffer(null);
            }
            break;

          case 'QUEUE_ERROR':
            setQueue(null);
            setAiOffer(null);
            toast(event.message, 'warn');
            void refresh();
            break;

          case 'AI_OFFER':
            setAiOffer({
              mode: event.mode,
              entryMicros: event.entryMicros,
              message: event.message,
              expiresAt: Date.now() + event.expiresInMs,
            });
            break;

          case 'BALANCE_UPDATED':
            setWallet((current) =>
              current
                ? {
                    ...current,
                    availableMicros: event.availableMicros || current.availableMicros,
                    lockedMicros: event.lockedMicros || current.lockedMicros,
                  }
                : current,
            );
            break;

          case 'ERROR':
            toast(event.message, 'error');
            break;

          default:
            break;
        }
      }),
    [refresh, toast],
  );

  const onServerEvent = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  // ---------------------------------------------------------------- actions

  const joinQueue = useCallback(
    async (mode: string, entryMicros?: string) => {
      try {
        const result = await api.post<{ state: string; matchId?: string }>(
          '/api/matchmaking/join',
          { mode, entryMicros },
        );
        if (result.state === 'WAITING') {
          setQueue({ active: true, mode, since: Date.now() });
        }
        await refresh();
      } catch (error) {
        if (error instanceof ApiError) {
          toast(error.message, error.code === 'INSUFFICIENT_BALANCE' ? 'warn' : 'error');
          if (error.code === 'INSUFFICIENT_BALANCE') setScreen('wallet');
        } else {
          toast('Could not join a match.', 'error');
        }
        setQueue(null);
      }
    },
    [refresh, toast],
  );

  const leaveQueue = useCallback(async () => {
    setQueue(null);
    setAiOffer(null);
    try {
      await api.post('/api/matchmaking/leave');
      await refresh();
    } catch {
      // Leaving is best-effort; the server also drops us on disconnect.
    }
  }, [refresh]);

  const acceptAi = useCallback(async () => {
    setAiOffer(null);
    try {
      await api.post('/api/matchmaking/accept-ai');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not start the AI match.', 'error');
      setQueue(null);
    }
  }, [toast]);

  const clearMatch = useCallback(() => {
    setMatch(null);
    setScreen('home');
    void refresh();
  }, [refresh]);

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      bootError,
      user,
      progress,
      wallet,
      rank,
      membership,
      config,
      screen,
      navigate,
      connection,
      rttMs,
      match,
      queue,
      aiOffer,
      toasts,
      toast,
      dismissToast,
      refresh,
      leaderboard,
      loadLeaderboard,
      joinQueue,
      leaveQueue,
      acceptAi,
      clearMatch,
      onServerEvent,
    }),
    [
      ready, bootError, user, progress, wallet, rank, membership, config, screen, navigate,
      connection, rttMs, match, queue, aiOffer, toasts, toast, dismissToast, refresh,
      leaderboard, loadLeaderboard, joinQueue, leaveQueue, acceptAi, clearMatch, onServerEvent,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
