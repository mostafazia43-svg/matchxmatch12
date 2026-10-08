/**
 * WebSocket gateway.
 *
 * Translates socket frames into service calls. Two things it does that matter
 * more than they look:
 *
 *   1. It stamps `arrivalMono` for a CLICK as the FIRST statement after the
 *      frame is read — before JSON parsing, before any lookup. Everything the
 *      process does afterwards would otherwise be charged to the player's
 *      reaction time.
 *
 *   2. It authenticates before it will act on anything. An unauthenticated
 *      socket may send exactly one message (HELLO) and is dropped if it does
 *      not, so an anonymous connection cannot sit and consume resources.
 */

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ErrorCode,
  TIMING,
  WS_PROTOCOL_VERSION,
  isClientEvent,
  type ClientEvent,
  type GameMode,
} from '@cb/shared';
import { queryOne } from '../db/pool.js';
import { isAppError } from '../lib/errors.js';
import { uuid } from '../lib/ids.js';
import { verifyToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { monoNow } from '../lib/time.js';
import { resolveSession } from '../modules/auth/service.js';
import * as engine from '../modules/game/engine.js';
import { matchView } from '../modules/game/store.js';
import * as matchmaking from '../modules/matchmaking/service.js';
import * as hub from './hub.js';

/** Cheap per-socket flood guard. Independent of the HTTP rate limiter. */
class MessageBudget {
  private tokens: number;
  private lastRefill = monoNow();

  constructor(private readonly capacity: number, private readonly perSecond: number) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = monoNow();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.perSecond);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

export function attachGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

  wss.on('connection', (socket: WebSocket, request) => {
    const budget = new MessageBudget(40, 20);
    let connection: hub.Connection | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let nonce = 0;

    const handshakeTimer = setTimeout(() => {
      if (!connection) socket.close(4001, 'authentication timeout');
    }, HANDSHAKE_TIMEOUT_MS);

    const fail = (code: string, message: string): void => {
      try {
        socket.send(JSON.stringify({ t: 'ERROR', code, message }));
      } catch {
        // socket already gone
      }
    };

    socket.on('message', (data, isBinary) => {
      // Stamp the instant the frame arrived, before doing any work with it.
      const arrivalMono = monoNow();

      if (isBinary) return;
      if (!budget.take()) {
        fail(ErrorCode.RATE_LIMITED, 'Too many messages.');
        socket.close(4029, 'flooding');
        return;
      }

      let event: ClientEvent;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!isClientEvent(parsed)) return;
        event = parsed;
      } catch {
        return;
      }

      if (!connection) {
        if (event.t !== 'HELLO') {
          socket.close(4001, 'expected HELLO');
          return;
        }
        void handleHello(event);
        return;
      }

      void handleEvent(connection, event, arrivalMono).catch((error) => {
        const code = isAppError(error) ? error.code : ErrorCode.INTERNAL;
        const message = isAppError(error) && error.exposeMessage ? error.message : 'Request failed.';
        if (!isAppError(error)) logger.error({ err: error, t: event.t }, 'ws handler failed');
        fail(code, message);
      });
    });

    async function handleHello(event: Extract<ClientEvent, { t: 'HELLO' }>): Promise<void> {
      try {
        const claims = await verifyToken(event.token);
        const user = await resolveSession(claims.sub, claims.jti);
        if (!user) {
          socket.close(4001, 'session revoked');
          return;
        }
        if (user.isBlocked) {
          socket.close(4003, 'account blocked');
          return;
        }

        clearTimeout(handshakeTimer);

        connection = {
          id: uuid(),
          userId: user.id,
          socket,
          connectedAt: monoNow(),
          lastPongAt: monoNow(),
          rttSamples: [],
          pendingPing: null,
          subscribedMatchId: null,
        };

        const { evicted } = hub.register(connection);
        for (const old of evicted) old.socket.close(4008, 'too many connections');

        hub.sendToConnection(connection, {
          t: 'WELCOME',
          userId: user.id,
          serverTime: Date.now(),
          v: WS_PROTOCOL_VERSION,
        });

        engine.handleReconnect(user.id);

        // If they were mid-match when the socket dropped, put them back in it.
        const liveId = engine.liveMatchFor(user.id);
        if (liveId) {
          const view = await matchView(liveId, user.id);
          if (view) hub.sendToConnection(connection, { t: 'MATCH_FOUND', match: view });
        }

        startPinging();
      } catch {
        socket.close(4001, 'authentication failed');
      }
    }

    function probeLatency(): void {
      if (!connection) return;
      nonce += 1;
      connection.pendingPing = { nonce, sentAt: monoNow() };
      hub.sendToConnection(connection, { t: 'PING', nonce, serverTime: Date.now() });
    }

    function startPinging(): void {
      // Probe immediately. Without this there is no RTT sample for the first
      // ping interval, so a match starting right after connect would give a
      // high-latency player zero compensation — the fairness the measurement
      // exists to provide.
      probeLatency();

      pingTimer = setInterval(() => {
        if (!connection) return;
        if (monoNow() - connection.lastPongAt > TIMING.PONG_TIMEOUT_MS) {
          socket.close(4000, 'pong timeout');
          return;
        }
        probeLatency();
      }, TIMING.PING_INTERVAL_MS);
    }

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (!connection) return;

      const { userId } = connection;
      hub.unregister(connection);
      connection = null;

      // Give a page refresh a moment to reconnect before declaring absence.
      setTimeout(() => {
        if (hub.isOnline(userId)) return;
        engine.handleDisconnect(userId);
        void matchmaking.onDisconnect(userId).catch(() => undefined);
      }, 800);
    });

    socket.on('error', (error) => {
      logger.debug({ err: error }, 'ws socket error');
    });
  });

  logger.info('websocket gateway attached at /ws');
  return wss;
}

async function handleEvent(
  connection: hub.Connection,
  event: ClientEvent,
  arrivalMono: number,
): Promise<void> {
  switch (event.t) {
    case 'PONG': {
      const rtt = hub.recordPong(connection, event.nonce);
      if (rtt !== null) hub.sendToConnection(connection, { t: 'LATENCY', rttMs: Math.round(rtt) });
      return;
    }

    case 'CLICK': {
      // The hot path: no awaits before the engine sees the arrival stamp.
      const outcome = engine.registerClick(
        connection.userId,
        event.matchId,
        event.roundNo,
        arrivalMono,
      );
      if (!outcome.accepted && outcome.reason === 'DUPLICATE') {
        hub.sendToConnection(connection, {
          t: 'CLICK_REJECTED',
          matchId: event.matchId,
          roundNo: event.roundNo,
          reason: 'DUPLICATE',
        });
      }
      return;
    }

    case 'QUEUE_JOIN': {
      const profile = await profileFor(connection.userId);
      await matchmaking.join({
        userId: connection.userId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        level: profile.level,
        mode: event.mode as GameMode,
        entryMicros: event.entryMicros ? BigInt(event.entryMicros) : 0n,
      });
      return;
    }

    case 'QUEUE_LEAVE':
      await matchmaking.leave(connection.userId);
      return;

    case 'AI_ACCEPT':
      await matchmaking.acceptAiOffer(connection.userId);
      return;

    case 'MATCH_SUBSCRIBE': {
      const view = await matchView(event.matchId, connection.userId);
      if (!view) return;
      // Only a participant may watch a match in progress.
      if (!view.players.some((p) => p.userId === connection.userId)) return;
      connection.subscribedMatchId = event.matchId;
      hub.sendToConnection(connection, { t: 'MATCH_FOUND', match: view });
      return;
    }

    case 'FORFEIT':
      engine.forfeit(connection.userId, event.matchId);
      return;

    case 'READY':
    case 'HELLO':
      return;
  }
}

interface ProfileRow {
  username: string | null;
  first_name: string;
  last_name: string | null;
  photo_url: string | null;
  level: number | null;
}

async function profileFor(userId: string): Promise<{
  displayName: string;
  avatarUrl: string | null;
  level: number;
}> {
  const row = await queryOne<ProfileRow>(
    `SELECT u.username, u.first_name, u.last_name, u.photo_url, p.level
       FROM users u LEFT JOIN player_progress p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const name =
    row?.username || [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || 'Player';
  return { displayName: name, avatarUrl: row?.photo_url ?? null, level: row?.level ?? 1 };
}
