/**
 * Connection registry.
 *
 * Owns the mapping from user -> live sockets and the latency measurement that
 * the game engine uses for fairness compensation. It knows nothing about
 * matches or money, so the engine can depend on it without a cycle.
 */

import type { WebSocket } from 'ws';
import { TIMING, type ServerEvent } from '@cb/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { monoNow } from '../lib/time.js';

export interface Connection {
  id: string;
  userId: string;
  socket: WebSocket;
  connectedAt: number;
  lastPongAt: number;
  /** Rolling RTT samples, newest last. */
  rttSamples: number[];
  pendingPing: { nonce: number; sentAt: number } | null;
  subscribedMatchId: string | null;
}

const byUser = new Map<string, Set<Connection>>();
const byId = new Map<string, Connection>();

export function register(connection: Connection): { evicted: Connection[] } {
  let set = byUser.get(connection.userId);
  if (!set) {
    set = new Set();
    byUser.set(connection.userId, set);
  }
  set.add(connection);
  byId.set(connection.id, connection);

  // Cap concurrent sockets per user. Multiple sessions are legitimate (phone +
  // desktop) but unbounded ones are a resource-exhaustion vector.
  const evicted: Connection[] = [];
  while (set.size > env.WS_MAX_CONNECTIONS_PER_USER) {
    const oldest = [...set].sort((a, b) => a.connectedAt - b.connectedAt)[0];
    if (!oldest) break;
    set.delete(oldest);
    byId.delete(oldest.id);
    evicted.push(oldest);
  }
  return { evicted };
}

export function unregister(connection: Connection): void {
  byId.delete(connection.id);
  const set = byUser.get(connection.userId);
  if (!set) return;
  set.delete(connection);
  if (set.size === 0) byUser.delete(connection.userId);
}

export function connectionsFor(userId: string): Connection[] {
  return [...(byUser.get(userId) ?? [])];
}

export function isOnline(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

export function onlineUserCount(): number {
  return byUser.size;
}

export function connectionCount(): number {
  return byId.size;
}

function serialise(event: ServerEvent): string {
  return JSON.stringify(event);
}

/** Send to every live socket of a user. Silently no-ops if they are offline. */
export function sendTo(userId: string, event: ServerEvent): void {
  const set = byUser.get(userId);
  if (!set || set.size === 0) return;
  const payload = serialise(event);
  for (const connection of set) {
    safeSend(connection, payload);
  }
}

export function sendToConnection(connection: Connection, event: ServerEvent): void {
  safeSend(connection, serialise(event));
}

function safeSend(connection: Connection, payload: string): void {
  // 1 === WebSocket.OPEN. A closing socket is not an error worth logging.
  if (connection.socket.readyState !== 1) return;
  try {
    connection.socket.send(payload);
  } catch (error) {
    logger.debug({ err: error, connectionId: connection.id }, 'ws send failed');
  }
}

/**
 * Round-trip time for a user, as the MINIMUM of recent samples.
 *
 * Minimum rather than mean is a deliberate anti-cheat choice: a client can
 * only ever make its RTT look WORSE (by delaying pongs), and inflated latency
 * buys compensation. The minimum is the hardest statistic to inflate, because
 * a single honest round trip pulls it back down.
 */
export function rttFor(userId: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (const connection of byUser.get(userId) ?? []) {
    for (const sample of connection.rttSamples) {
      if (sample < best) best = sample;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

export function recordPong(connection: Connection, nonce: number): number | null {
  const pending = connection.pendingPing;
  connection.lastPongAt = monoNow();
  if (!pending || pending.nonce !== nonce) return null;

  const rtt = monoNow() - pending.sentAt;
  connection.pendingPing = null;
  // Discard absurd samples — a backgrounded mobile tab produces multi-second
  // "round trips" that say nothing about the network.
  if (rtt >= 0 && rtt < 5_000) {
    connection.rttSamples.push(rtt);
    if (connection.rttSamples.length > TIMING.RTT_SAMPLES) connection.rttSamples.shift();
  }
  return rtt;
}

export function closeAll(code = 1001, reason = 'server shutting down'): void {
  for (const connection of byId.values()) {
    try {
      connection.socket.close(code, reason);
    } catch {
      // already gone
    }
  }
  byId.clear();
  byUser.clear();
}
