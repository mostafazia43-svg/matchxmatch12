/**
 * Telegram WebApp bridge.
 *
 * Every call is optional-chained and wrapped: the Mini App must still render
 * in a plain browser (for development and for the odd Telegram client that
 * lags behind the SDK), so a missing API degrades rather than crashes.
 *
 * Note what is NOT used here: `initDataUnsafe.user` is only ever read for
 * cosmetics before login. Identity comes exclusively from the server, which
 * verifies the signed `initData` string.
 */

interface HapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: { id: number; first_name?: string; username?: string; photo_url?: string };
    start_param?: string;
  };
  version: string;
  colorScheme: 'light' | 'dark';
  themeParams?: Record<string, string>;
  isExpanded: boolean;
  viewportStableHeight?: number;
  ready(): void;
  expand(): void;
  close(): void;
  enableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  openTelegramLink?(url: string): void;
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
  showAlert?(message: string, callback?: () => void): void;
  HapticFeedback?: HapticFeedback;
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function webApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function isInsideTelegram(): boolean {
  const app = webApp();
  return Boolean(app && app.initData && app.initData.length > 0);
}

/** The signed payload the backend verifies. Never parsed or trusted here. */
export function initData(): string {
  return webApp()?.initData ?? '';
}

export function initTelegram(): void {
  const app = webApp();
  if (!app) return;

  try {
    app.ready();
    app.expand();
    app.setHeaderColor?.('#0a0b12');
    app.setBackgroundColor?.('#0a0b12');
    // A stray vertical swipe during a round would otherwise collapse the app
    // mid-tap — costly in a game measured in milliseconds.
    app.disableVerticalSwipes?.();
  } catch {
    // An older client missing a method must not stop the app from loading.
  }
}

/**
 * Haptics.
 *
 * Used sparingly and always as confirmation of something that already
 * happened — never as a hint about what is about to happen, which would leak
 * the GO moment through a second channel.
 */
export const haptic = {
  tap(): void {
    try {
      webApp()?.HapticFeedback?.impactOccurred('medium');
    } catch {
      /* unsupported */
    }
  },
  success(): void {
    try {
      webApp()?.HapticFeedback?.notificationOccurred('success');
    } catch {
      /* unsupported */
    }
  },
  error(): void {
    try {
      webApp()?.HapticFeedback?.notificationOccurred('error');
    } catch {
      /* unsupported */
    }
  },
  select(): void {
    try {
      webApp()?.HapticFeedback?.selectionChanged();
    } catch {
      /* unsupported */
    }
  },
};

export function openLink(url: string): void {
  if (!url) return;
  const app = webApp();
  try {
    if (url.includes('t.me') && app?.openTelegramLink) app.openTelegramLink(url);
    else if (app?.openLink) app.openLink(url);
    else window.open(url, '_blank', 'noopener');
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * Show or hide Telegram's native back button.
 *
 * The previous handler is always detached before a new one is attached —
 * Telegram's `onClick` appends rather than replaces, so without this the button
 * would accumulate handlers and fire several navigations per press.
 */
let currentBackHandler: (() => void) | null = null;

export function setBackButton(onBack: (() => void) | null): void {
  const button = webApp()?.BackButton;
  if (!button) return;

  try {
    if (currentBackHandler) {
      button.offClick(currentBackHandler);
      currentBackHandler = null;
    }
    if (!onBack) {
      button.hide();
      return;
    }
    currentBackHandler = onBack;
    button.onClick(onBack);
    button.show();
  } catch {
    // Older clients without BackButton support simply do without it.
  }
}
