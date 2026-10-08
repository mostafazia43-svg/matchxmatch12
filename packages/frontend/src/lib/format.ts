import { formatMicros } from '@cb/shared';

/** "$9.50" — money is formatted from the exact micro string, never a float. */
export function usd(micros: string | bigint, decimals = 2): string {
  const value = typeof micros === 'bigint' ? micros : BigInt(micros || '0');
  return `$${formatMicros(value, { decimals })}`;
}

export function usdt(micros: string | bigint): string {
  const value = typeof micros === 'bigint' ? micros : BigInt(micros || '0');
  return `${formatMicros(value)} USDT`;
}

export function compact(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ms(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}
