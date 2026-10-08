/** Small presentational building blocks shared across screens. */

import type { CSSProperties, ReactNode } from 'react';
import { initials } from '../lib/format.js';

export function Avatar({
  name,
  url,
  size = 'md',
}: {
  name: string;
  url?: string | null;
  size?: 'sm' | 'md' | 'lg';
}): JSX.Element {
  const className = `avatar${size === 'lg' ? ' avatar--lg' : size === 'sm' ? ' avatar--sm' : ''}`;
  if (url) {
    return (
      <img
        className={className}
        src={url}
        alt=""
        // A broken Telegram CDN link should fall back to initials, not a
        // broken-image icon.
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
    );
  }
  return <div className={className}>{initials(name)}</div>;
}

export function Card({
  children,
  accent,
  flush,
  className = '',
  style,
}: {
  children: ReactNode;
  accent?: boolean;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div
      className={`card${accent ? ' card--accent' : ''}${flush ? ' card--flush' : ''} ${className}`.trim()}
      style={style}
    >
      {children}
    </div>
  );
}

export function Stat({ value, label }: { value: ReactNode; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

export function Pill({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'win' | 'lose' | 'paid' | 'accent';
}): JSX.Element {
  return <span className={`pill${tone ? ` pill--${tone}` : ''}`}>{children}</span>;
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}): JSX.Element {
  return <div className={`banner banner--${tone}`}>{children}</div>;
}

export function Empty({
  icon,
  title,
  hint,
}: {
  icon: string;
  title: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div style={{ fontWeight: 650, color: 'var(--text-dim)' }}>{title}</div>
      {hint ? <div className="small" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

export function Spinner(): JSX.Element {
  return <div className="spinner" />;
}

export function XpBar({ progress }: { progress: number }): JSX.Element {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div className="xp-bar">
      <div className="xp-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Connection quality indicator.
 *
 * Shown because latency genuinely affects a reaction game. The thresholds
 * match what the server compensates for, so a player seeing "good" can trust
 * that their ping is not costing them rounds.
 */
export function ConnectionDot({
  status,
  rttMs,
}: {
  status: string;
  rttMs: number;
}): JSX.Element {
  if (status !== 'open') {
    return (
      <span className="pill">
        <span className="dot dot--bad" />
        {status === 'reconnecting' ? 'Reconnecting' : 'Offline'}
      </span>
    );
  }
  const tone = rttMs < 120 ? 'good' : rttMs < 260 ? 'fair' : 'bad';
  const label = rttMs < 120 ? 'Good' : rttMs < 260 ? 'Fair' : 'Slow';
  return (
    <span className="pill">
      <span className={`dot dot--${tone}`} />
      {label} · {Math.round(rttMs)}ms
    </span>
  );
}

export function Sheet({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss?: () => void;
}): JSX.Element {
  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss?.();
      }}
    >
      <div className="sheet">{children}</div>
    </div>
  );
}
