import { randomUUID } from 'node:crypto';
import type { PlayerState } from './game.js';

export type ChatSendPayload = { text: string };
export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
};

/** Validate plain text by Unicode code points, rejecting client-supplied sender metadata. */
export function parseChatPayload(value: Record<string, unknown>): ChatSendPayload | undefined {
  if (Object.keys(value).some((key) => key !== 'text') || typeof value.text !== 'string') return;
  const text = value.text.trim();
  if (!text || Array.from(text).length > 200) return;
  return { text };
}

/** Derive identity and time on the server so clients cannot impersonate another player. */
export function createChatMessage(player: PlayerState, payload: ChatSendPayload): ChatMessage {
  return {
    id: randomUUID(),
    senderId: player.id,
    senderName: player.name,
    text: payload.text,
    timestamp: Date.now(),
  };
}
