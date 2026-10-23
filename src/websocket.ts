import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { createPlayer, applyPlayerMovement, parseClientMessage, type PlayerState } from './game.js';
import { logger } from './utils/logger.js';
import { createChatMessage } from './chat.js';

const MAX_PLAYERS = 5;
/** Attach the single shared world to / on the existing HTTP server. */
export function initializeWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/', maxPayload: 4096 });
  const players = new Map<string, PlayerState>();
  const sessions = new Map<
    WebSocket,
    {
      player?: PlayerState;
      lastSequence: number;
      movementTimes: number[];
      alive: boolean;
      messages: number;
      lastChatAt: number;
    }
  >();

  function send(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // Slow receivers must not accumulate an unbounded queue of stale world updates.
    if (socket.bufferedAmount > 64 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(message, (error) => {
      if (error) {
        logger.warn({ err: error }, 'WebSocket send failed');
        socket.terminate();
      }
    });
  }

  function broadcast(type: string, payload: unknown, excluded?: WebSocket): void {
    const message = JSON.stringify({ type, payload });
    for (const [socket, session] of sessions) {
      if (session.player && socket !== excluded) send(socket, message);
    }
  }

  // Explicit errors let clients handle rejected requests using the documented protocol.
  function reject(socket: WebSocket, code: string, message: string): void {
    logger.warn({ code }, 'WebSocket request rejected');
    send(socket, JSON.stringify({ type: 'server:error', payload: { code, message } }));
  }

  wss.on('connection', (socket) => {
    // Reserve capacity before join so idle sockets cannot bypass the five-client limit.
    if (sessions.size >= MAX_PLAYERS) {
      logger.warn('WebSocket room full');
      reject(socket, 'ROOM_FULL', 'Maximum 5 players allowed.');
      socket.close(1013, 'Room full');
      return;
    }
    const session = {
      player: undefined as PlayerState | undefined,
      lastSequence: -1,
      movementTimes: [] as number[],
      alive: true,
      messages: 0,
      lastChatAt: -Infinity,
    };
    sessions.set(socket, session);
    const joinTimeout = setTimeout(() => socket.close(1008, 'Join timeout'), 10_000);
    socket.on('pong', () => {
      session.alive = true;
    });
    socket.on('error', (err) => {
      logger.warn({ err }, 'WebSocket connection error');
      socket.terminate();
    });
    socket.on('message', (raw, binary) => {
      // Limit work per connection as well as payload size; malformed traffic never mutates state.
      if (++session.messages > 120 || binary) {
        reject(socket, 'INVALID_MESSAGE', 'Invalid message or rate limit.');
        socket.close(1008, 'Invalid message or rate limit');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        logger.warn('Malformed WebSocket JSON');
        reject(socket, 'INVALID_MESSAGE', 'Invalid JSON.');
        return;
      }
      const message = parseClientMessage(value);
      if (!message) {
        reject(socket, 'INVALID_MESSAGE', 'Invalid message type or payload.');
        return;
      }
      if (message.type === 'player:join' && session.player) {
        reject(socket, 'ALREADY_JOINED', 'Player already joined.');
        return;
      }
      if (message.type !== 'player:join' && !session.player) {
        reject(socket, 'NOT_JOINED', 'Join before sending movement or chat.');
        return;
      }
      if (message.type === 'player:join') {
        clearTimeout(joinTimeout);
        const player = createPlayer(message.payload);
        session.player = player;
        players.set(player.id, player);
        send(
          socket,
          JSON.stringify({
            type: 'world:init',
            payload: { playerId: player.id, players: [...players.values()] },
          }),
        );
        broadcast('player:joined', { player }, socket);
        logger.info({ playerId: player.id }, 'Player joined');
        return;
      }
      if (message.type === 'chat:send') {
        if (!session.player) return;
        // Use monotonic time and charge only accepted messages to avoid clock changes and invalid-input penalties.
        const now = performance.now();
        if (now - session.lastChatAt < 1000) {
          reject(socket, 'CHAT_RATE_LIMITED', 'Wait one second between chat messages.');
          return;
        }
        session.lastChatAt = now;
        // Include the sender in this immediate broadcast; chat is independent of movement updates.
        broadcast('chat:message', createChatMessage(session.player, message.payload));
        return;
      }
      if (!session.player) return;
      // A session owns its ID; stale packets cannot overwrite its latest reported state.
      if (message.payload.sequence <= session.lastSequence) {
        reject(socket, 'INVALID_MESSAGE', 'Movement sequence must increase.');
        return;
      }
      // A rolling window limits movement traffic independently of chat and heartbeat timers.
      const now = performance.now();
      session.movementTimes = session.movementTimes.filter((time) => now - time < 1000);
      if (session.movementTimes.length >= 20) {
        reject(socket, 'RATE_LIMITED', 'Maximum 20 movement updates per second.');
        return;
      }
      session.movementTimes.push(now);
      session.lastSequence = message.payload.sequence;
      if (applyPlayerMovement(session.player, message.payload)) {
        // Relay accepted values only to peers; the sender already renders its local movement.
        broadcast('player:update', { id: session.player.id, ...message.payload }, socket);
      }
    });
    socket.on('close', () => {
      clearTimeout(joinTimeout);
      sessions.delete(socket);
      if (!session.player) return;
      players.delete(session.player.id);
      broadcast('player:left', { id: session.player.id });
      logger.info({ playerId: session.player.id }, 'Player disconnected');
    });
  });

  const rateWindow = setInterval(() => {
    for (const session of sessions.values()) session.messages = 0;
  }, 1000);
  const heartbeat = setInterval(() => {
    for (const [socket, session] of sessions) {
      if (!session.alive) {
        socket.terminate();
        continue;
      }
      session.alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 30_000);
  wss.on('error', (err) => logger.error({ err }, 'WebSocket server error'));
  wss.on('close', () => {
    clearInterval(rateWindow);
    clearInterval(heartbeat);
  });
  return wss;
}
