/**
 * TON / USDT provider abstraction.
 *
 * The rest of the application talks to this interface and never to a chain
 * API directly, so a real provider can be swapped in through `TON_PROVIDER`
 * without touching the wallet or game code.
 *
 * Deliberate non-goal: this file does NOT invent blockchain behaviour. The
 * mock driver is honest about being a mock — it never claims a transfer was
 * confirmed on-chain, and it refuses to run in production.
 */

import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface IncomingTransfer {
  /** Chain transaction hash — the natural idempotency key for a deposit. */
  txHash: string;
  fromAddress: string | null;
  toAddress: string;
  amountMicros: bigint;
  /** Memo/comment used to attribute the transfer to a player. */
  comment: string | null;
  confirmations: number;
  timestamp: Date;
  raw: Record<string, unknown>;
}

export interface PayoutRequest {
  withdrawalId: string;
  toAddress: string;
  amountMicros: bigint;
  comment?: string;
}

export interface PayoutResult {
  txHash: string;
  status: 'SENT' | 'QUEUED';
}

export interface TonProvider {
  readonly name: string;
  /** True when the driver can actually reach a chain. */
  readonly live: boolean;
  /** Incoming USDT transfers to the platform address, newest first. */
  listIncoming(options: { sinceIso?: string; limit?: number }): Promise<IncomingTransfer[]>;
  /** Send a payout. Throws if automated payouts are not configured. */
  sendPayout(request: PayoutRequest): Promise<PayoutResult>;
  isValidAddress(address: string): boolean;
  healthcheck(): Promise<boolean>;
}

/**
 * TON addresses are 48-character base64url (user-friendly form) or raw
 * `workchain:hex`. This is a shape check, not a checksum verification — the
 * provider rejects a genuinely bad address at send time, and payouts are
 * admin-reviewed before that point.
 */
export function looksLikeTonAddress(address: string): boolean {
  const value = address.trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(value)) return true;
  return /^[A-Za-z0-9_-]{48}$/.test(value);
}

// ---------------------------------------------------------------- mock

/**
 * Development driver. Deposits are injected through `injectDeposit()` (used by
 * the admin "simulate deposit" tool and the tests) rather than observed on a
 * chain. Payouts are recorded but never broadcast.
 */
class MockProvider implements TonProvider {
  readonly name = 'mock';
  readonly live = false;
  private readonly pending: IncomingTransfer[] = [];

  injectDeposit(transfer: Omit<IncomingTransfer, 'raw'> & { raw?: Record<string, unknown> }): void {
    this.pending.unshift({ ...transfer, raw: transfer.raw ?? { simulated: true } });
  }

  async listIncoming({ limit = 50 }: { sinceIso?: string; limit?: number }): Promise<IncomingTransfer[]> {
    return this.pending.slice(0, limit);
  }

  async sendPayout(request: PayoutRequest): Promise<PayoutResult> {
    logger.warn(
      { withdrawalId: request.withdrawalId },
      'mock provider: payout recorded but NOT broadcast — pay this out manually',
    );
    return { txHash: `mock-${request.withdrawalId}`, status: 'QUEUED' };
  }

  isValidAddress(address: string): boolean {
    return looksLikeTonAddress(address);
  }

  async healthcheck(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------- tonapi

interface TonApiEvent {
  event_id?: string;
  timestamp?: number;
  actions?: {
    type?: string;
    status?: string;
    JettonTransfer?: {
      sender?: { address?: string };
      recipient?: { address?: string };
      amount?: string;
      comment?: string | null;
      jetton?: { address?: string; decimals?: number };
    };
  }[];
}

/**
 * tonapi.io driver.
 *
 * Reads jetton transfers into the platform address and filters them to the
 * configured USDT master, so a worthless look-alike jetton cannot be used to
 * credit a real balance.
 */
class TonApiProvider implements TonProvider {
  readonly name = 'tonapi';
  readonly live = true;

  private async call<T>(path: string): Promise<T> {
    const url = `${env.TONAPI_BASE_URL.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (env.TONAPI_KEY) headers.Authorization = `Bearer ${env.TONAPI_KEY}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw errors.providerUnavailable(`TON API responded ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      logger.error({ err: error, path }, 'TON API call failed');
      throw errors.providerUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  async listIncoming({ limit = 50 }: { sinceIso?: string; limit?: number }): Promise<IncomingTransfer[]> {
    if (!env.PLATFORM_WALLET_ADDRESS) return [];

    const data = await this.call<{ events?: TonApiEvent[] }>(
      `/v2/accounts/${encodeURIComponent(env.PLATFORM_WALLET_ADDRESS)}/events?limit=${limit}`,
    );

    const transfers: IncomingTransfer[] = [];
    for (const event of data.events ?? []) {
      for (const action of event.actions ?? []) {
        const transfer = action.JettonTransfer;
        if (action.type !== 'JettonTransfer' || !transfer) continue;
        if (action.status && action.status !== 'ok') continue;

        // Only the configured USDT jetton counts as a deposit.
        if (
          env.USDT_JETTON_MASTER &&
          transfer.jetton?.address &&
          transfer.jetton.address !== env.USDT_JETTON_MASTER
        ) {
          continue;
        }
        if (transfer.recipient?.address !== env.PLATFORM_WALLET_ADDRESS) continue;

        const decimals = transfer.jetton?.decimals ?? env.USDT_DECIMALS;
        const rawAmount = BigInt(transfer.amount ?? '0');
        // Normalise to 6-decimal micro units regardless of the jetton's decimals.
        const amountMicros =
          decimals >= 6
            ? rawAmount / 10n ** BigInt(decimals - 6)
            : rawAmount * 10n ** BigInt(6 - decimals);
        if (amountMicros <= 0n) continue;

        transfers.push({
          txHash: event.event_id ?? '',
          fromAddress: transfer.sender?.address ?? null,
          toAddress: env.PLATFORM_WALLET_ADDRESS,
          amountMicros,
          comment: transfer.comment ?? null,
          confirmations: 1,
          timestamp: new Date((event.timestamp ?? 0) * 1000),
          raw: event as unknown as Record<string, unknown>,
        });
      }
    }
    return transfers.filter((t) => t.txHash);
  }

  async sendPayout(request: PayoutRequest): Promise<PayoutResult> {
    // Signing requires a hot wallet key. Until an operator explicitly enables
    // it, withdrawals stay manual — which is the safer default for real money.
    if (!env.TON_PAYOUT_ENABLED) {
      throw errors.providerUnavailable(
        'Automated payouts are disabled. An administrator must send this withdrawal manually.',
      );
    }
    throw errors.providerUnavailable(
      'Automated payout signing is not configured. Set up a signer service and wire it here.',
    );
  }

  isValidAddress(address: string): boolean {
    return looksLikeTonAddress(address);
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.call('/v2/status');
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- selection

let instance: TonProvider | null = null;

export function tonProvider(): TonProvider {
  if (instance) return instance;

  if (env.TON_PROVIDER === 'tonapi') {
    instance = new TonApiProvider();
  } else {
    if (env.isProduction) {
      throw new Error(
        'TON_PROVIDER=mock is not allowed in production — it cannot verify real deposits.',
      );
    }
    logger.warn('using the MOCK TON provider — no real deposits will be detected');
    instance = new MockProvider();
  }
  return instance;
}

/** Test/admin hook: only meaningful for the mock driver. */
export function mockProvider(): MockProvider | null {
  const provider = tonProvider();
  return provider instanceof MockProvider ? provider : null;
}

export function resetProviderForTest(): void {
  instance = null;
}
