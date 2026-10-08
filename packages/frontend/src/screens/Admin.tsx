/**
 * Admin panel.
 *
 * Lives inside the Mini App because the operator is already a Telegram-verified
 * user — a separate admin app would need a second auth system, which is a
 * second thing to get wrong. Access is enforced server-side on every request;
 * hiding this tab is convenience, not security.
 */

import { useCallback, useEffect, useState } from 'react';
import { Banner, Card, Empty, Pill } from '../components/ui.js';
import { ApiError, api, requestKey } from '../lib/api.js';
import { compact, timeAgo, usd } from '../lib/format.js';
import { useStore } from '../state/store.js';

type Tab = 'overview' | 'users' | 'withdrawals' | 'security' | 'settings';

interface Dashboard {
  users: { total: number; active24h: number; new24h: number; blocked: number; online: number };
  matches: {
    total: number; active: number; live: number; free: number; paid: number; demo: number;
    today: number; queued: number; queueBreakdown: Record<string, number>;
  };
  money: {
    depositsMicros: string; withdrawalsMicros: string; commissionMicros: string;
    prizesMicros: string; userBalancesMicros: string; lockedMicros: string;
  };
  alerts: { openSuspicious: number; pendingWithdrawals: number; orphanDeposits: number };
  provider: { name: string; live: boolean };
}

interface AdminUser {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string;
  is_blocked: boolean;
  available_micros: string | null;
  level: number | null;
  points: string | null;
  total_matches: number | null;
  wins: number | null;
  last_seen_at: string;
}

interface Withdrawal {
  id: string;
  user_id: string;
  username: string | null;
  telegram_id: string;
  to_address: string;
  amount_micros: string;
  status: string;
  created_at: string;
}

interface SuspiciousEvent {
  id: string;
  username: string | null;
  kind: string;
  severity: number;
  detail: Record<string, unknown>;
  created_at: string;
}

export function AdminScreen(): JSX.Element {
  const { user, toast } = useStore();
  const [tab, setTab] = useState<Tab>('overview');

  if (!user?.isAdmin) {
    return (
      <div className="screen">
        <Banner tone="error">Administrator access required.</Banner>
      </div>
    );
  }

  return (
    <div className="screen stack" style={{ gap: 14 }}>
      <h1>Admin</h1>

      <div className="scroll-x">
        {(['overview', 'users', 'withdrawals', 'security', 'settings'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`btn btn--sm${tab === key ? ' btn--primary' : ''}`}
            onClick={() => setTab(key)}
          >
            {key.charAt(0).toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <Overview /> : null}
      {tab === 'users' ? <Users toast={toast} /> : null}
      {tab === 'withdrawals' ? <Withdrawals toast={toast} /> : null}
      {tab === 'security' ? <Security /> : null}
      {tab === 'settings' ? <Settings toast={toast} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview(): JSX.Element {
  const [data, setData] = useState<Dashboard | null>(null);

  useEffect(() => {
    const load = () => api.get<Dashboard>('/api/admin/dashboard').then(setData).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!data) {
    return (
      <div className="empty">
        <div className="spinner" style={{ margin: '0 auto' }} />
      </div>
    );
  }

  const alerts =
    data.alerts.openSuspicious + data.alerts.pendingWithdrawals + data.alerts.orphanDeposits;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {!data.provider.live ? (
        <Banner tone="warn">
          TON provider is <strong>{data.provider.name}</strong> — no real deposits are being
          detected. Set TON_PROVIDER=tonapi for live operation.
        </Banner>
      ) : null}

      {alerts > 0 ? (
        <Banner tone="warn">
          {data.alerts.pendingWithdrawals > 0
            ? `${data.alerts.pendingWithdrawals} withdrawal(s) awaiting review. `
            : ''}
          {data.alerts.openSuspicious > 0
            ? `${data.alerts.openSuspicious} open security flag(s). `
            : ''}
          {data.alerts.orphanDeposits > 0
            ? `${data.alerts.orphanDeposits} unattributed deposit(s).`
            : ''}
        </Banner>
      ) : null}

      <div>
        <div className="section-title">Revenue</div>
        <Card accent>
          <div className="tiny dim">Total commission earned</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--accent)' }}>
            {usd(data.money.commissionMicros)}
          </div>
        </Card>
      </div>

      <div className="stat-grid">
        <Stat3 value={usd(data.money.depositsMicros)} label="Deposits" />
        <Stat3 value={usd(data.money.withdrawalsMicros)} label="Withdrawn" />
        <Stat3 value={usd(data.money.prizesMicros)} label="Prizes paid" />
      </div>

      <Card>
        <div className="row row--between small">
          <span className="dim">User balances held</span>
          <span className="mono">{usd(data.money.userBalancesMicros)}</span>
        </div>
        <div className="row row--between small">
          <span className="dim">Locked in live matches</span>
          <span className="mono">{usd(data.money.lockedMicros)}</span>
        </div>
      </Card>

      <div>
        <div className="section-title">Players</div>
        <div className="stat-grid">
          <Stat3 value={compact(data.users.total)} label="Total" />
          <Stat3 value={data.users.online} label="Online now" />
          <Stat3 value={compact(data.users.active24h)} label="Active 24h" />
        </div>
      </div>

      <div>
        <div className="section-title">Matches</div>
        <div className="stat-grid">
          <Stat3 value={data.matches.live} label="Live" />
          <Stat3 value={data.matches.queued} label="In queue" />
          <Stat3 value={compact(data.matches.today)} label="Today" />
        </div>
        <Card style={{ marginTop: 8 }}>
          <div className="row row--between small">
            <span className="dim">Free / Paid / Demo</span>
            <span className="mono">
              {compact(data.matches.free)} / {compact(data.matches.paid)} /{' '}
              {compact(data.matches.demo)}
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat3({ value, label }: { value: string | number; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat__value" style={{ fontSize: 16 }}>
        {value}
      </div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------- users

function Users({ toast }: { toast: (text: string, tone?: 'info' | 'success' | 'warn' | 'error') => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<AdminUser[]>(`/api/admin/users?limit=40&q=${encodeURIComponent(search)}`)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(load, 300);
    return () => window.clearTimeout(timer);
  }, [load]);

  const toggleBlock = useCallback(
    async (target: AdminUser) => {
      const blocking = !target.is_blocked;
      const reason = blocking ? prompt('Reason for blocking this account?') : null;
      if (blocking && reason === null) return;

      setBusy(target.id);
      try {
        await api.post(`/api/admin/users/${target.id}/block`, { blocked: blocking, reason });
        toast(blocking ? 'User blocked' : 'User unblocked', 'success');
        load();
      } catch (error) {
        toast(error instanceof ApiError ? error.message : 'Action failed', 'error');
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  const adjust = useCallback(
    async (target: AdminUser) => {
      const input = prompt('Adjustment in USDT (negative to deduct):');
      if (!input) return;
      const reason = prompt('Reason (recorded in the audit log):');
      if (!reason) return;

      const value = Number(input);
      if (!Number.isFinite(value) || value === 0) {
        toast('Invalid amount', 'error');
        return;
      }

      setBusy(target.id);
      try {
        await api.post(`/api/admin/users/${target.id}/adjust`, {
          amountMicros: String(Math.round(value * 1_000_000)),
          reason,
          requestKey: requestKey(),
        });
        toast('Balance adjusted', 'success');
        load();
      } catch (error) {
        toast(error instanceof ApiError ? error.message : 'Adjustment failed', 'error');
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  return (
    <div className="stack">
      <input
        className="field"
        placeholder="Search username or Telegram ID…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      {users.length === 0 ? (
        <Card>
          <Empty icon="🔍" title="No users found" />
        </Card>
      ) : (
        <Card flush>
          {users.map((row) => (
            <div key={row.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="truncate" style={{ fontWeight: 650, fontSize: 14 }}>
                    {row.username ? `@${row.username}` : row.first_name}
                  </span>
                  {row.is_blocked ? <Pill tone="lose">Blocked</Pill> : null}
                </div>
                <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  ID {row.telegram_id} · Lv {row.level ?? 1} · {row.wins ?? 0}W/
                  {row.total_matches ?? 0} · {usd(row.available_micros ?? '0')} ·{' '}
                  {timeAgo(row.last_seen_at)}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={busy === row.id}
                  onClick={() => void adjust(row)}
                >
                  ±$
                </button>
                <button
                  type="button"
                  className={`btn btn--sm${row.is_blocked ? '' : ' btn--danger'}`}
                  disabled={busy === row.id}
                  onClick={() => void toggleBlock(row)}
                >
                  {row.is_blocked ? 'Unblock' : 'Block'}
                </button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- withdrawals

function Withdrawals({
  toast,
}: {
  toast: (text: string, tone?: 'info' | 'success' | 'warn' | 'error') => void;
}): JSX.Element {
  const [rows, setRows] = useState<Withdrawal[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Withdrawal[]>(`/api/admin/withdrawals?status=${status}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [status]);

  useEffect(load, [load]);

  const review = useCallback(
    async (id: string, decision: 'APPROVE' | 'REJECT' | 'MARK_SENT') => {
      let note: string | null = null;
      let txHash: string | null = null;

      if (decision === 'REJECT') {
        note = prompt('Reason for rejection (the player sees this):');
        if (note === null) return;
      }
      if (decision === 'MARK_SENT') {
        txHash = prompt('On-chain transaction hash:');
        if (!txHash) return;
      }

      setBusy(id);
      try {
        await api.post(`/api/admin/withdrawals/${id}/review`, { decision, note, txHash });
        toast(`Withdrawal ${decision.toLowerCase().replace('_', ' ')}`, 'success');
        load();
      } catch (error) {
        toast(error instanceof ApiError ? error.message : 'Review failed', 'error');
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  return (
    <div className="stack">
      <div className="scroll-x">
        {['PENDING', 'APPROVED', 'SENT', 'REJECTED'].map((key) => (
          <button
            key={key}
            type="button"
            className={`btn btn--sm${status === key ? ' btn--primary' : ''}`}
            onClick={() => setStatus(key)}
          >
            {key}
          </button>
        ))}
      </div>

      <Banner tone="info">
        The amount has already left the player's balance. Approving marks it ready to pay; use
        <strong> Mark sent</strong> after the on-chain transfer, and <strong>Reject</strong> to
        refund it in full.
      </Banner>

      {rows.length === 0 ? (
        <Card>
          <Empty icon="✅" title={`No ${status.toLowerCase()} withdrawals`} />
        </Card>
      ) : (
        <Card flush>
          {rows.map((row) => (
            <div key={row.id} className="list-item" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{usd(row.amount_micros)}</div>
                <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {row.username ? `@${row.username}` : row.telegram_id} · {timeAgo(row.created_at)}
                </div>
                <div
                  className="tiny mono truncate"
                  style={{ textTransform: 'none', letterSpacing: 0, maxWidth: '100%' }}
                >
                  {row.to_address}
                </div>
              </div>
              {row.status === 'PENDING' || row.status === 'APPROVED' ? (
                <div className="row" style={{ gap: 6 }}>
                  {row.status === 'PENDING' ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy === row.id}
                      onClick={() => void review(row.id, 'APPROVE')}
                    >
                      Approve
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={busy === row.id}
                      onClick={() => void review(row.id, 'MARK_SENT')}
                    >
                      Mark sent
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy === row.id}
                    onClick={() => void review(row.id, 'REJECT')}
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <Pill tone={row.status === 'SENT' ? 'win' : 'lose'}>{row.status}</Pill>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- security

function Security(): JSX.Element {
  const [events, setEvents] = useState<SuspiciousEvent[]>([]);

  useEffect(() => {
    api
      .get<SuspiciousEvent[]>('/api/admin/suspicious?resolved=false')
      .then(setEvents)
      .catch(() => setEvents([]));
  }, []);

  return (
    <div className="stack">
      <Banner tone="info">
        Flags are raised only for physically impossible input — a reaction faster than any human
        could produce. Ordinary false starts are handled by the game rules and are not logged here.
      </Banner>

      {events.length === 0 ? (
        <Card>
          <Empty icon="🛡️" title="No open flags" hint="Nothing suspicious detected." />
        </Card>
      ) : (
        <Card flush>
          {events.map((event) => (
            <div key={event.id} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 650, fontSize: 14 }}>{event.kind}</span>
                  <Pill tone={event.severity >= 3 ? 'lose' : undefined}>S{event.severity}</Pill>
                </div>
                <div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {event.username ? `@${event.username}` : 'unknown'} · {timeAgo(event.created_at)}
                </div>
                <div
                  className="tiny mono faint"
                  style={{ textTransform: 'none', letterSpacing: 0, marginTop: 2 }}
                >
                  {JSON.stringify(event.detail)}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  void api
                    .post(`/api/admin/suspicious/${event.id}/resolve`)
                    .then(() => setEvents((current) => current.filter((e) => e.id !== event.id)));
                }}
              >
                Resolve
              </button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings

const SETTING_GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Game modes', keys: ['game.free_enabled', 'game.paid_enabled', 'game.demo_enabled'] },
  { title: 'Economy', keys: ['game.commission_bps', 'game.paid_tiers_micros'] },
  {
    title: 'Match format',
    keys: [
      'game.rounds_to_win',
      'game.max_rounds',
      'game.countdown_ms',
      'game.round_timeout_ms',
      'game.go_jitter_min_ms',
      'game.go_jitter_max_ms',
      'game.min_human_reaction_ms',
      'game.max_rtt_compensation_ms',
      'game.disconnect_grace_ms',
    ],
  },
  { title: 'Matchmaking', keys: ['matchmaking.timeout_ms'] },
  {
    title: 'AI opponent',
    keys: [
      'ai.enabled',
      'ai.paid_policy',
      'ai.reaction_mean_ms',
      'ai.reaction_stddev_ms',
      'ai.reaction_min_ms',
      'ai.reaction_max_ms',
      'ai.false_start_chance',
    ],
  },
  {
    title: 'Progression',
    keys: [
      'xp.free_win', 'xp.free_loss', 'xp.paid_win', 'xp.paid_loss', 'xp.round_win',
      'points.free_win', 'points.paid_win', 'points.streak_bonus',
      'level.curve_base', 'level.curve_exponent', 'level.max',
    ],
  },
  {
    title: 'Telegram membership',
    keys: ['membership.enabled', 'membership.chat', 'membership.invite_url', 'membership.required_for'],
  },
  {
    title: 'Wallet',
    keys: [
      'wallet.deposits_enabled', 'wallet.withdrawals_enabled', 'wallet.min_deposit_micros',
      'wallet.min_withdrawal_micros', 'wallet.withdrawal_fee_micros', 'wallet.required_confirmations',
    ],
  },
  { title: 'Operations', keys: ['ops.maintenance_mode', 'ops.maintenance_message'] },
];

function Settings({
  toast,
}: {
  toast: (text: string, tone?: 'info' | 'success' | 'warn' | 'error') => void;
}): JSX.Element {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ settings: Record<string, unknown> }>('/api/admin/settings')
      .then((data) => setSettings(data.settings))
      .catch(() => setSettings({}));
  }, []);

  const save = useCallback(
    async (key: string, value: unknown) => {
      setSaving(key);
      try {
        const updated = await api.put<Record<string, unknown>>('/api/admin/settings', { key, value });
        setSettings(updated);
        toast('Saved', 'success');
      } catch (error) {
        toast(error instanceof ApiError ? error.message : 'Save failed', 'error');
      } finally {
        setSaving(null);
      }
    },
    [toast],
  );

  if (!settings) {
    return (
      <div className="empty">
        <div className="spinner" style={{ margin: '0 auto' }} />
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Banner tone="info">
        Changes apply within a few seconds — no restart needed. Every change is recorded in the
        audit log.
      </Banner>

      {SETTING_GROUPS.map((group) => (
        <div key={group.title}>
          <div className="section-title">{group.title}</div>
          <Card flush>
            {group.keys.map((key) => (
              <SettingRow
                key={key}
                settingKey={key}
                value={settings[key]}
                saving={saving === key}
                onSave={save}
              />
            ))}
          </Card>
        </div>
      ))}
    </div>
  );
}

function SettingRow({
  settingKey,
  value,
  saving,
  onSave,
}: {
  settingKey: string;
  value: unknown;
  saving: boolean;
  onSave: (key: string, value: unknown) => Promise<void>;
}): JSX.Element {
  const label = settingKey.split('.').slice(1).join('.').replace(/_/g, ' ');

  if (typeof value === 'boolean') {
    return (
      <div className="list-item">
        <span className="small" style={{ flex: 1, textTransform: 'capitalize' }}>
          {label}
        </span>
        <button
          type="button"
          className={`btn btn--sm${value ? ' btn--primary' : ' btn--ghost'}`}
          disabled={saving}
          onClick={() => void onSave(settingKey, !value)}
        >
          {value ? 'On' : 'Off'}
        </button>
      </div>
    );
  }

  const serialised = typeof value === 'string' ? value : JSON.stringify(value);

  return (
    <div className="list-item">
      <span className="small" style={{ flex: 1, textTransform: 'capitalize', minWidth: 0 }}>
        {label}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--ghost mono"
        disabled={saving}
        style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onClick={() => {
          const input = prompt(`${settingKey}`, serialised);
          if (input === null) return;
          let parsed: unknown = input;
          if (typeof value !== 'string') {
            try {
              parsed = JSON.parse(input);
            } catch {
              parsed = input;
            }
          }
          void onSave(settingKey, parsed);
        }}
      >
        {saving ? '…' : serialised}
      </button>
    </div>
  );
}
