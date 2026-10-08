/**
 * WebSocket client.
 *
 * Reconnects with backoff, replies to server pings immediately (the RTT sample
 * it produces is what the server uses to compensate this player's latency —
 * delaying a pong makes the connection look worse, not better), and exposes a
 * plain subscribe/send surface.
 */

import { WS_PROTOCOL_VERSION, type ClientEvent, type ServerEvent } from '@cb/shared';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

type EventListener = (event: ServerEvent) => void;
type StatusListener = (status: ConnectionStatus, rttMs: number) => void;

const MAX_BACKOFF_MS = 15_000;

class GameSocket {
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private status: ConnectionStatus = 'idle';
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private rttMs = 0;
  private seq = 0;

  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();

  connect(token: string): void {
    this.token = token;
    this.intentionalClose = false;
    this.open();
  }

  private url(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  private open(): void {
    if (!this.token) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      socket.send(JSON.stringify({ t: 'HELLO', token: this.token!, v: WS_PROTOCOL_VERSION }));
    };

    socket.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }

      // Answer immediately — this measurement decides our latency compensation.
      if (event.t === 'PING') {
        this.send({ t: 'PONG', nonce: event.nonce });
        return;
      }
      if (event.t === 'WELCOME') {
        this.setStatus('open');
        return;
      }
      if (event.t === 'LATENCY') {
        this.rttMs = event.rttMs;
        this.notifyStatus();
        return;
      }

      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('socket listener failed', error);
        }
      }
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.intentionalClose) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows; the reconnect is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.setStatus('reconnecting');
    this.attempts += 1;

    // Exponential backoff with jitter, so a server restart does not summon a
    // thundering herd of every client at the same millisecond.
    const base = Math.min(500 * 2 ** (this.attempts - 1), MAX_BACKOFF_MS);
    const delay = base * (0.7 + Math.random() * 0.6);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  send(event: ClientEvent): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  /** Fire a click. The payload carries no timing — the server clocks arrival. */
  click(matchId: string, roundNo: number): boolean {
    this.seq += 1;
    return this.send({ t: 'CLICK', matchId, roundNo, seq: this.seq });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'client closing');
    this.socket = null;
    this.setStatus('closed');
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.rttMs);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getRtt(): number {
    return this.rttMs;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener(this.status, this.rttMs);
  }
}

export const socket = new GameSocket();
