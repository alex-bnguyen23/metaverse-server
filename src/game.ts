import { randomUUID } from 'node:crypto';
import { parseChatPayload, type ChatSendPayload } from './chat.js';
import { parseVehicleMessage, type VehicleMessage } from './vehicle.js';

export type Appearance = {
  shirt: 0 | 1 | 2;
  pants: 0 | 1;
  hairstyle: 0 | 1;
  glasses: 0 | 1;
};

/** World-space coordinates shared with Three.js clients. */
export type Vector3 = { x: number; y: number; z: number };
export type AnimationState = 'Idle' | 'Walk' | 'Run';

/** Fixed models cannot carry custom materials; selection is stored once per session. */
export type CharacterSelection =
  { model: 'custom'; appearance: Appearance } | { model: 'person3' | 'person2' | 'ceo'; appearance: null };

export type PlayerJoinPayload = { name: string } & CharacterSelection;

export type PlayerState = {
  id: string;
  name: string;
  position: Vector3;
  rotation: number;
  animation: 'Idle' | 'Walk' | 'Run';
} & CharacterSelection;

export type PlayerMovement = {
  sequence: number;
  position: Vector3;
  rotation: number;
  animation: AnimationState;
};
export type ClientMessage =
  | VehicleMessage
  | { type: 'player:join'; payload: PlayerJoinPayload }
  | { type: 'player:move'; payload: PlayerMovement }
  | { type: 'chat:send'; payload: ChatSendPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate all client payloads before they can affect the shared world or chat. */
export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!isRecord(value) || !isRecord(value.payload)) return;
  const data = value.payload;
  if (typeof value.type === 'string' && value.type.startsWith('vehicle:')) {
    return parseVehicleMessage(value.type, data);
  }
  if (value.type === 'chat:send') {
    const payload = parseChatPayload(data);
    return payload ? { type: 'chat:send', payload } : undefined;
  }
  if (value.type === 'player:join') {
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 24) return;
    // Legacy clients may omit model, but explicit null and unknown IDs must fail validation.
    const model = Object.prototype.hasOwnProperty.call(data, 'model') ? data.model : 'custom';
    if (model === 'person3' || model === 'person2' || model === 'ceo') {
      if (data.appearance !== null) return;
      return {
        type: 'player:join',
        payload: { name: data.name.trim(), model, appearance: null },
      };
    }
    const appearance = data.appearance;
    if (
      model !== 'custom' ||
      typeof data.name !== 'string' ||
      data.name.trim().length < 1 ||
      data.name.trim().length > 24 ||
      !isRecord(appearance) ||
      ![0, 1, 2].includes(appearance.shirt as number) ||
      ![0, 1].includes(appearance.pants as number) ||
      ![0, 1].includes(appearance.hairstyle as number) ||
      ![0, 1].includes(appearance.glasses as number)
    )
      return;
    return {
      type: 'player:join',
      payload: {
        name: data.name.trim(),
        model,
        appearance: {
          shirt: appearance.shirt as Appearance['shirt'],
          pants: appearance.pants as Appearance['pants'],
          hairstyle: appearance.hairstyle as Appearance['hairstyle'],
          glasses: appearance.glasses as Appearance['glasses'],
        },
      },
    };
  }
  // Clients own movement; only structurally valid, finite state crosses this boundary.
  const position = data.position;
  if (
    value.type === 'player:move' &&
    typeof data.sequence === 'number' &&
    Number.isSafeInteger(data.sequence) &&
    data.sequence >= 0 &&
    isRecord(position) &&
    typeof position.x === 'number' &&
    Number.isFinite(position.x) &&
    typeof position.y === 'number' &&
    Number.isFinite(position.y) &&
    typeof position.z === 'number' &&
    Number.isFinite(position.z) &&
    typeof data.rotation === 'number' &&
    Number.isFinite(data.rotation) &&
    (data.animation === 'Idle' || data.animation === 'Walk' || data.animation === 'Run')
  )
    return {
      type: 'player:move',
      payload: {
        sequence: data.sequence,
        position: { x: position.x, y: position.y, z: position.z },
        rotation: data.rotation,
        animation: data.animation,
      },
    };
}

/** Spawn players at the world entry point; clients never select their ID or position. */
export function createPlayer(
  data: Extract<ClientMessage, { type: 'player:join' }>['payload'],
): PlayerState {
  return {
    id: randomUUID(),
    ...data,
    position: { x: 0, y: 0, z: 23.55 },
    rotation: 0,
    animation: 'Idle',
  };
}

/** Store client-reported movement verbatim, returning whether remote players need an update. */
export function applyPlayerMovement(player: PlayerState, movement: PlayerMovement): boolean {
  const changed =
    player.position.x !== movement.position.x ||
    player.position.y !== movement.position.y ||
    player.position.z !== movement.position.z ||
    player.rotation !== movement.rotation ||
    player.animation !== movement.animation;
  player.position = { ...movement.position };
  player.rotation = movement.rotation;
  player.animation = movement.animation;
  return changed;
}
