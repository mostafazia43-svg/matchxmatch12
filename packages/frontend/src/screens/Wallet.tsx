/**
 * Wallet: deposit instructions, withdrawal request, and the statement.
 *
 * The deposit flow is memo-based because that is how the backend attributes an
 * on-chain transfer to a player. The memo is presented as a required step, not
 * an optional field, since a transfer without it lands in manual review.
 */

import { useCallback, useEffect, useState } from 'react';
import { toMicros } from '@cb/shared';
import { Banner, Card, Empty, Pill } from '../components/ui.js';
import { ApiError, api, requestKey } from '../lib/api.js';
import { timeAgo, usd } from '../lib/format.js';
import { haptic } from '../lib/telegram.js';
import { useStore } from '../state/store.js';

interface TransactionRow {
  id: string;
  type: string;
  status: string;
  amountMicros: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface WithdrawalRow {
  id: string;
  toAddress: string;
  amountMicros: string;
  status: string;
  note: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<string, string> = {
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  MATCH_ENTRY: 'Match entry',
  COMMISSION: 'Platform fee',
  PRIZE: 'Prize',
  REFUND: 'Refund',
  ADMIN_ADJUSTMENT: 'Adjustment',
};

export function WalletScreen(): JSX.Element {
  const { wallet, config, refresh, toast } = useStore();
  const [tab, setTab] = useState<'deposit' | 'withdraw' | 'history'>('deposit');
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[]>([]);

  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadHistory = useCallback(() => {
    api.get<TransactionRow[]>('/api/wallet/transactions?limit=50').then(setTransactions).catch(() => undefined);
    api.get<WithdrawalRow[]>('/api/wallet/withdrawals').then(setWithdrawals).catch(() => undefined);
  }, []);

  useEffect(loadHistory, [loadHistory]);

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        haptic.success();
        toast(`${label} copied`, 'success');
      } catch {
        toast('Copy failed — select and copy manually.', 'warn');
      }
    },
    [toast],
  );

  const submitWithdrawal = useCallback(async () => {
    if (submitting) return;
    let micros: bigint;
    try {
      micros = toMicros(amount.trim());
    } catch {
      toast('Enter a valid amount.', 'error');
      return;
    }
    if (micros <= 0n) {
      toast('Enter an amount greater than zero.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/wallet/withdraw', {
        amountMicros: micros.toString(),
        toAddress: address.trim(),
        // Generated per attempt so a double-tap cannot create two withdrawals.
        requestKey: requestKey(),
      });
      toast('Withdrawal requested. It will be reviewed shortly.', 'success');
      setAmount('');
      await refresh();
      loadHistory();
      setTab('history');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Withdrawal failed.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [amount, address, submitting, refresh, toast, loadHistory]);

  if (!wallet || !config) {
    return (
      <div className="screen">
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      </div>
    );
  }

  const available = BigInt(wallet.availableMicros);
  const locked = BigInt(wallet.lockedMicros);
  const minWithdrawal = BigInt(config.wallet.minWithdrawalMicros);
  const fee = BigInt(config.wallet.withdrawalFeeMicros);

  return (
    <div className="screen stack" style={{ gap: 16 }}>
      <h1>Wallet</h1>

      <Card accent>
        <div className="tiny dim">Available</div>
        <div style={{ fontSize: 34, fontWeight: 800 }}>{usd(available)}</div>
        <div className="small dim">USDT on TON</div>
        {locked > 0n ? (
          <div className="tiny" style={{ color: 'var(--warn)', marginTop: 6 }}>
            {usd(locked)} reserved for a match in progress
          </div>
        ) : null}
      </Card>

      <div className="scroll-x">
        {(['deposit', 'withdraw', 'history'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`btn btn--sm${tab === key ? ' btn--primary' : ''}`}
            onClick={() => setTab(key)}
          >
            {key === 'deposit' ? 'Deposit' : key === 'withdraw' ? 'Withdraw' : 'History'}
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------------- deposit */}
      {tab === 'deposit' ? (
        !config.wallet.depositsEnabled ? (
          <Banner tone="warn">Deposits are temporarily disabled.</Banner>
        ) : (
          <div className="stack">
            <Banner tone="info">
              Send <strong>USDT on the TON network</strong> to the address below. You{' '}
              <strong>must</strong> include the memo — without it we cannot tell the transfer is
              yours and it will need manual review.
            </Banner>

            <Card>
              <div className="tiny dim">Step 1 — Address</div>
              <div
                className="mono small"
                style={{ wordBreak: 'break-all', margin: '6px 0 10px', userSelect: 'text' }}
              >
                {wallet.depositAddress || 'Not configured'}
              </div>
              <button
                type="button"
                className="btn btn--sm btn--block"
                onClick={() => void copy(wallet.depositAddress, 'Address')}
              >
                Copy address
              </button>
            </Card>

            <Card>
              <div className="tiny dim">Step 2 — Memo / comment (required)</div>
              <div
                className="mono"
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: 'var(--accent)',
                  margin: '6px 0 10px',
                  userSelect: 'text',
                }}
              >
                {wallet.depositMemo}
              </div>
              <button
                type="button"
                className="btn btn--sm btn--block"
                onClick={() => void copy(wallet.depositMemo, 'Memo')}
              >
                Copy memo
              </button>
            </Card>

            <div className="small faint">
              Minimum deposit {usd(config.wallet.minDepositMicros)}. Your balance updates
              automatically once the transfer is confirmed on-chain — usually within a minute.
            </div>
          </div>
        )
      ) : null}

      {/* ---------------------------------------------------------- withdraw */}
      {tab === 'withdraw' ? (
        !config.wallet.withdrawalsEnabled ? (
          <Banner tone="warn">Withdrawals are temporarily disabled.</Banner>
        ) : (
          <div className="stack">
            <Card>
              <div className="tiny dim" style={{ marginBottom: 6 }}>
                Amount (USDT)
              </div>
              <input
                className="field"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => setAmount((Number(available) / 1_000_000).toFixed(2))}
                >
                  Max
                </button>
                <span className="small faint">Available {usd(available)}</span>
              </div>
            </Card>

            <Card>
              <div className="tiny dim" style={{ marginBottom: 6 }}>
                Your TON address
              </div>
              <input
                className="field"
                placeholder="UQ…"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <div className="tiny faint" style={{ marginTop: 8, textTransform: 'none', letterSpacing: 0 }}>
                Double-check this. Transfers on TON cannot be reversed.
              </div>
            </Card>

            <Card>
              <div className="row row--between small">
                <span className="dim">Minimum</span>
                <span className="mono">{usd(minWithdrawal)}</span>
              </div>
              <div className="row row--between small">
                <span className="dim">Network fee</span>
                <span className="mono">{usd(fee)}</span>
              </div>
            </Card>

            <button
              type="button"
              className="btn btn--primary btn--block"
              disabled={submitting || !amount || address.trim().length < 10}
              onClick={() => void submitWithdrawal()}
            >
              {submitting ? 'Requesting…' : 'Request withdrawal'}
            </button>

            <div className="small faint">
              Withdrawals are reviewed before payout. The amount leaves your balance immediately so
              it cannot be spent twice; if a request is rejected, it is refunded in full.
            </div>
          </div>
        )
      ) : null}

      {/* ---------------------------------------------------------- history */}
      {tab === 'history' ? (
        <div className="stack">
          {withdrawals.length > 0 ? (
            <>
              <div className="section-title">Withdrawal requests</div>
              <Card flush>
                {withdrawals.map((row) => (
                  <div key={row.id} className="list-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 650 }}>{usd(row.amountMicros)}</div>
                      <div
                        className="tiny faint truncate"
                        style={{ textTransform: 'none', letterSpacing: 0 }}
                      >
                        {row.toAddress}
                      </div>
                      {row.note ? <div className="tiny faint">{row.note}</div> : null}
                    </div>
                    <Pill
                      tone={
                        row.status === 'SENT' ? 'win' : row.status === 'REJECTED' ? 'lose' : undefined
                      }
                    >
                      {row.status}
                    </Pill>
                  </div>
                ))}
              </Card>
            </>
          ) : null}

          <div className="section-title">Statement</div>
          {transactions.length === 0 ? (
            <Card>
              <Empty icon="📋" title="No transactions yet" />
            </Card>
          ) : (
            <Card flush>
              {transactions.map((row) => {
                const amount = BigInt(row.amountMicros);
                const isFee = row.type === 'COMMISSION';
                return (
                  <div key={row.id} className="list-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {TYPE_LABEL[row.type] ?? row.type}
                      </div>
                      <div
                        className="tiny faint"
                        style={{ textTransform: 'none', letterSpacing: 0 }}
                      >
                        {timeAgo(row.createdAt)}
                        {isFee ? ' · included in your entry' : ''}
                        {row.status !== 'CONFIRMED' ? ` · ${row.status}` : ''}
                      </div>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontWeight: 700,
                        color: isFee
                          ? 'var(--text-faint)'
                          : amount > 0n
                            ? 'var(--win)'
                            : 'var(--text-dim)',
                      }}
                    >
                      {amount > 0n ? '+' : '−'}
                      {usd(amount < 0n ? -amount : amount)}
                    </div>
                  </div>
                );
              })}
            </Card>
          )}
        </div>
      ) : null}
    </div>
  );
}
