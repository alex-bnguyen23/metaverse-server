import type { PlayerState, Vector3 } from './game.js';

/** Shared world placement and limits must match the frontend's driving configuration. */
export const vehicleConfig = {
  id: 'cybertruck-1',
  spawn: { position: { x: -35, y: 0, z: 0 }, rotation: Math.PI / 2 },
  worldBounds: { min: { x: -70, y: -2, z: -70 }, max: { x: 72, y: 25, z: 70 } },
  minSpeed: -4,
  maxSpeed: 10,
  maxAbsSteering: Math.PI / 6,
  enterRadius: 3,
  exitRadius: 3,
} as const;

export type VehicleSeat = 'driver' | 'passenger';

export type VehicleState = {
  id: 'cybertruck-1';
  driverId: string | null;
  passengerId: string | null;
  revision: number;
  position: Vector3;
  rotation: number;
  speed: number;
  steering: number;
  wheelAngle: number;
};
type VehicleRequest = { vehicleId: string; revision: number };
export type VehicleMovement = VehicleRequest & {
  sequence: number;
  position: Vector3;
  rotation: number;
  speed: number;
  steering: number;
  wheelAngle: number;
};
export type VehicleMessage =
  | { type: 'vehicle:enter'; payload: VehicleRequest & { seat: VehicleSeat } }
  | { type: 'vehicle:exit'; payload: VehicleRequest & { position: Vector3; rotation: number } }
  | { type: 'vehicle:move'; payload: VehicleMovement };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function counter(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}
function vector(value: unknown): value is Vector3 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return finite(point.x) && finite(point.y) && finite(point.z);
}

/** Copy only protocol fields so client-supplied identities never enter shared state. */
export function parseVehicleMessage(
  type: unknown,
  data: Record<string, unknown>,
): VehicleMessage | undefined {
  if (typeof data.vehicleId !== 'string' || !counter(data.revision)) return;
  const request = { vehicleId: data.vehicleId, revision: data.revision };
  if (type === 'vehicle:enter') {
    if (data.seat !== 'driver' && data.seat !== 'passenger') return;
    return { type, payload: { ...request, seat: data.seat } };
  }
  if (!vector(data.position) || !finite(data.rotation)) return;
  const transform = { position: { ...data.position }, rotation: data.rotation };
  if (type === 'vehicle:exit') return { type, payload: { ...request, ...transform } };
  if (
    type === 'vehicle:move' &&
    counter(data.sequence) &&
    finite(data.speed) &&
    finite(data.steering) &&
    finite(data.wheelAngle)
  ) {
    return {
      type,
      payload: {
        ...request,
        ...transform,
        sequence: data.sequence,
        speed: data.speed,
        steering: data.steering,
        wheelAngle: data.wheelAngle,
      },
    };
  }
}

/** Validate bounds without clamping client reports or simulating collisions. */
export function withinVehicleBounds(position: Vector3): boolean {
  return (['x', 'y', 'z'] as const).every(
    (axis) =>
      position[axis] >= vehicleConfig.worldBounds.min[axis] &&
      position[axis] <= vehicleConfig.worldBounds.max[axis],
  );
}
function nearby(a: Vector3, b: Vector3, radius: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= radius;
}

/** One synchronous controller serializes seat leases; state survives an empty room. */
export class SharedVehicle {
  readonly state: VehicleState = {
    id: vehicleConfig.id,
    driverId: null,
    passengerId: null,
    revision: 0,
    position: { ...vehicleConfig.spawn.position },
    rotation: vehicleConfig.spawn.rotation,
    speed: 0,
    steering: 0,
    wheelAngle: 0,
  };
  private lastSequence = -1;

  /** Return a rejection code before changing either the vehicle or the player. */
  apply(player: PlayerState, message: VehicleMessage): string | undefined {
    const data = message.payload;
    const state = this.state;
    if (data.vehicleId !== state.id) return 'VEHICLE_NOT_FOUND';
    if (data.revision !== state.revision) return 'STALE_VEHICLE_REVISION';
    // Revisions must remain representable even after the next occupancy transition.
    if (message.type !== 'vehicle:move' && state.revision === Number.MAX_SAFE_INTEGER)
      return 'INVALID_VEHICLE_STATE';
    if (message.type === 'vehicle:enter') {
      if (this.seatOf(player.id)) return 'ALREADY_IN_VEHICLE';
      // Reserve safe revisions for both occupants to disconnect without overflow.
      if (state.revision >= Number.MAX_SAFE_INTEGER - 2) return 'INVALID_VEHICLE_STATE';
      if (state.speed !== 0) return 'VEHICLE_MOVING';
      const key = message.payload.seat === 'driver' ? 'driverId' : 'passengerId';
      if (state[key] !== null) return 'VEHICLE_OCCUPIED';
      if (!nearby(player.position, state.position, vehicleConfig.enterRadius))
        return 'VEHICLE_TOO_FAR';
      state[key] = player.id;
      this.transition();
      this.syncPlayer(player);
      return;
    }
    if (message.type === 'vehicle:exit') {
      if (!this.seatOf(player.id)) return 'NOT_IN_VEHICLE';
      if (state.speed !== 0) return 'VEHICLE_MOVING';
      if (
        !withinVehicleBounds(message.payload.position) ||
        !nearby(message.payload.position, state.position, vehicleConfig.exitRadius)
      )
        return 'INVALID_EXIT_POSITION';
      this.release(player.id);
      player.position = { ...message.payload.position };
      player.rotation = message.payload.rotation;
      player.animation = 'Idle';
      return;
    }
    if (state.driverId !== player.id) return 'NOT_VEHICLE_DRIVER';
    const movement = message.payload;
    if (movement.sequence <= this.lastSequence) return 'STALE_VEHICLE_SEQUENCE';
    if (
      !withinVehicleBounds(movement.position) ||
      movement.speed < vehicleConfig.minSpeed ||
      movement.speed > vehicleConfig.maxSpeed ||
      Math.abs(movement.steering) > vehicleConfig.maxAbsSteering
    )
      return 'INVALID_VEHICLE_STATE';
    state.position = { ...movement.position };
    state.rotation = movement.rotation;
    state.speed = movement.speed;
    state.steering = movement.steering;
    state.wheelAngle = movement.wheelAngle;
    this.lastSequence = movement.sequence;
    this.syncPlayer(player);
  }

  /** Resolve seat ownership from server state, never from client identities. */
  seatOf(playerId: string): VehicleSeat | undefined {
    if (this.state.driverId === playerId) return 'driver';
    if (this.state.passengerId === playerId) return 'passenger';
    return undefined;
  }

  /** Release one seat; a disconnected passenger must not brake the driver. */
  release(playerId: string, disconnected = false): void {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    this.state[seat === 'driver' ? 'driverId' : 'passengerId'] = null;
    this.transition(disconnected && seat === 'passenger');
  }

  /** Keep late-join player snapshots aligned with both seated occupants. */
  syncOccupants(players: ReadonlyMap<string, PlayerState>): void {
    for (const id of [this.state.driverId, this.state.passengerId]) {
      const player = id === null ? undefined : players.get(id);
      if (player) this.syncPlayer(player);
    }
  }

  private transition(preserveMotion = false): void {
    this.state.revision += 1;
    if (!preserveMotion) {
      this.state.speed = 0;
      this.state.steering = 0;
    }
    this.lastSequence = -1;
  }

  private syncPlayer(player: PlayerState): void {
    // Visual seat offsets belong to clients; stored feet positions stay at the pivot.
    player.position = { ...this.state.position };
    player.rotation = this.state.rotation;
    player.animation = 'Idle';
  }
}
