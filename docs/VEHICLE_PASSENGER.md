# Two-seat vehicle backend contract

## Status and rollout

This contract is implemented by this backend for one driver and one passenger in the shared `cybertruck-1`. It supersedes the former single-driver vehicle protocol. Backend tests cover seat allocation, synchronization and releases. The frontend must implement the same contract before deployment; live browser integration has not been verified.

This changes vehicle payloads and validation. Do not silently mix old and new vehicle clients. There is no protocol negotiation in the current application; coordinate deployment and require existing browser sessions to reload/reconnect. Walking, chat, character selection, one shared room, the five-player total limit, and one socket per session remain unchanged. Both occupants count toward the five-player limit.

## Authority and configuration

The backend owns seat allocation, validates reports, and stores accepted state. The driver frontend calculates movement and collisions; the passenger never simulates or publishes vehicle movement. This extension adds no backend physics or simulation loop.

Retain the existing vehicle configuration: spawn `(-35, 0, 0)`, heading `Math.PI / 2`, inclusive world bounds `(-70, -2, -70)` through `(72, 25, 70)`, speed range `[-4, 10]`, maximum absolute steering `Math.PI / 6`, and three-dimensional enter/exit radius of 3 world units from the vehicle pivot. Keep the existing world-space drive-control pivot, parent-transform handling, and wheel-angle conventions.

## Shared schemas

`Vector3` and `PlayerState` retain their definitions in PROTOCOLS.md.

```ts
type VehicleSeat = 'driver' | 'passenger';

type VehicleState = {
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

type VehicleEnterPayload = {
  vehicleId: 'cybertruck-1';
  revision: number;
  seat: VehicleSeat;
};

type VehicleMovement = {
  vehicleId: 'cybertruck-1';
  revision: number;
  sequence: number;
  position: Vector3;
  rotation: number;
  speed: number;
  steering: number;
  wheelAngle: number;
};

type VehicleExitPayload = {
  vehicleId: 'cybertruck-1';
  revision: number;
  position: Vector3;
  rotation: number;
};

type VehicleOccupiedPayload = {
  vehicle: VehicleState;
  playerId: string;
  seat: VehicleSeat;
};

type VehicleReleasedPayload = {
  vehicle: VehicleState;
  playerId: string;
  seat: VehicleSeat;
} & ({ reason: 'exit'; player: PlayerState } | { reason: 'disconnect'; player: null });
```

All envelopes remain `{ type, payload }`. Use `vehicle:enter`, `vehicle:move`, `vehicle:exit`, `vehicle:occupied`, `vehicle:update`, and `vehicle:released`; add no passenger-specific movement event. `vehicle:update` remains `{ vehicle: VehicleState, sequence: number }`.

Require explicit `passengerId`, including null, in every vehicle snapshot. Each non-null occupant must reference a joined player, and the two IDs must differ. A player cannot occupy another seat while already seated. A null driver requires speed and steering to be zero; a passenger may remain in a driverless parked truck. Initially both seats are null and revision is zero. Preserve signed speed, steering in radians, and cumulative unwrapped wheel angle. Never accept occupant IDs from client reports; construct stored VehicleState from server-owned occupancy and validated movement fields.

## Revision and ordering

Keep a single revision counter. It is a nonnegative safe integer incremented exactly once for every accepted seat entry, seat exit, or occupant disconnect, including passenger transitions. Serialize all vehicle requests and disconnects atomically per vehicle, and broadcast transitions in that same order on each socket.

Every revision begins a new movement sequence epoch: reset the backend's last accepted vehicle sequence to -1 and the driver's next outgoing sequence to 0. Passenger changes also reset this epoch even when the driver stays the same. Reject old-revision reports; they cannot move the truck or restore an occupant. Reject duplicate/non-increasing sequences within the current revision. Increment revisions safely without overflowing the safe-integer range.

On an accepted occupancy event, clients apply the full authoritative vehicle snapshot, discard old prediction/interpolation and stopped-acknowledgement state, and reset vehicle sequence tracking. An unrelated occupant's event must not acknowledge or cancel a local pending request. Revalidate queued requests against the new revision. A driver still waiting to exit must obtain a fresh stopped acknowledgement in the new revision before resending exit. Do not reset walking sequences.

Ignore older/equal-revision occupancy events and older-revision movement updates. Movement with an unknown newer revision requires a fresh join to resynchronize; never infer seat ownership from it. A rejection containing a newer revision is not a state snapshot and cannot grant a seat.

## Initialization and seat entry

`world:init.payload.vehicles` contains exactly the shared truck with both occupant fields. `players` includes both occupants. The server stores each seated player's position at the truck pivot, rotation at its heading, and animation as `Idle`, preserving name, model and appearance. Visual seat offsets are frontend-local and are not separate authoritative player positions.

Example passenger request:

```json
{
  "type": "vehicle:enter",
  "payload": {
    "vehicleId": "cybertruck-1",
    "revision": 1,
    "seat": "passenger"
  }
}
```

For either seat, require a joined session, matching revision, latest accepted speed exactly zero, requested seat empty, requester not seated, and latest stored player feet position within the enter radius. A passenger may enter a parked truck without a driver. Never substitute another seat if the requested seat is occupied.

Atomically assign only the requested seat, increment revision, reset movement ordering, set speed and steering to zero, preserve the parked transform and wheel angle, and synchronize all remaining occupants' stored player transforms. Broadcast `vehicle:occupied` with `{ vehicle, playerId, seat }` to all joined clients, including the requester. The playerId is resolved from the requesting socket. Wait for this grant before disabling walking and entering the seat. A rejection changes no game state.

Two requests using the same revision cannot both succeed: after the first grant, the other is stale, even if it requests the other seat. Clients apply the broadcast and let the user retry with the latest revision; do not automatically retry rejected requests indefinitely.

## Driving and passenger synchronization

Only the current driver can send `vehicle:move`; passenger or unseated senders receive `NOT_VEHICLE_DRIVER`. Require the current revision, increasing safe-integer sequence, finite numbers, configured coordinate bounds and speed/steering limits. Store accepted movement and update both occupants' stored transforms to the pivot/heading with `Idle`. Broadcast `vehicle:update` to all joined clients, including both occupants. Do not broadcast separate `player:update` messages for occupants.

Both occupants stop sending `player:move`. Retain `PLAYER_DRIVING` for rejected driver walking reports and add `PLAYER_IN_VEHICLE` for passenger walking reports. Neither rejection consumes the walking sequence. Passengers cannot steer, brake, publish movement, or control driver exit. They follow the interpolated truck; the driver uses local prediction with accepted echoes as acknowledgements without rewinding newer prediction. Ignore walking updates for seated players.

Movement is sent only when changed, at most 20 messages per second in the existing rolling vehicle budget, separately from walking. Send a final stopped report, including after an epoch reset when a stopped acknowledgement is needed, then remain silent until state changes. Passengers send no periodic position messages.

## Independent exits

Either occupant sends `vehicle:exit` with VehicleExitPayload. Do not accept a target player ID or seat in this request: infer the requester's seat from server state. Require a joined seated requester, matching revision, latest accepted speed exactly zero, finite exit position/rotation, position within world bounds, and distance within the exit radius. The frontend finds unobstructed supported ground outside the truck; a blocked exit leaves the player seated. The server performs numeric/proximity checks, not collision simulation.

The driver brakes locally, freezes stopped prediction, sends a final stopped report and waits for its matching `vehicle:update` acknowledgement before requesting exit. A passenger uses the latest accepted stopped state and requests exit directly; it must not wait for acknowledgement of a movement report of its own. If the driver moves before the request is processed, reject with `VEHICLE_MOVING`. Passengers must wait for the driver to stop; their exit request does not brake the truck.

Atomically clear only the requester's seat, increment revision, reset movement ordering, preserve transform and wheel angle, and set speed/steering to zero. Set the departing player's stored transform to the accepted exit point with `Idle`; retain full character selection. Synchronize the remaining occupant at the pivot. Broadcast `vehicle:released` with `{ vehicle, playerId, seat, reason: "exit", player }` to everyone. `player.id` must equal playerId and the identified seat must be null in the new snapshot; the other seat is unchanged.

Clients apply the release atomically, restore only the departing character at the accepted exit position, and enable that player's walking after confirmation. The remaining occupant stays seated. A passenger is never automatically promoted to driver. To drive after the driver leaves, the passenger must exit and explicitly request the driver seat. Rejections preserve occupancy and do not resume walking.

## Disconnect and reconnect

On occupant disconnect or heartbeat timeout, clear only that occupant's seat, increment revision, and reset movement ordering. Driver disconnect stops the truck immediately at its last accepted transform with speed and steering zero; retain the passenger. Passenger disconnect preserves the driver's accepted transform, speed, steering and wheel angle, including while moving; the driver continues in the new sequence epoch. Preserve wheel angle in both cases.

Broadcast `vehicle:released` with `{ vehicle, playerId, seat, reason: "disconnect", player: null }` before `player:left`. Include the departed ID even though the player snapshot is null. Do not invent an exit point or eject the remaining occupant. An unseated disconnect does not change vehicle revision. If both occupants disconnect, serialize the two releases separately.

A reconnect creates a fresh player identity, receives current occupancy in world:init, and never restores old seat privileges. Retain parked state in backend memory while the room is empty; restart resets the truck to configured spawn with empty seats.

## Errors and limits

Use `server:error` with mandatory code/message and, for structurally valid vehicle requests, requestType, vehicleId, and current revision. Rejection must not mutate occupancy, transforms or movement sequences. Malformed payloads use `INVALID_MESSAGE`. Apply the existing rolling limit of two combined entry/exit requests per second per session, including structurally valid rejected attempts; requests beyond the limit do not extend the window. Retain existing 4 KiB payload and socket backpressure rules.

| Code                     | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `VEHICLE_NOT_FOUND`      | Unknown vehicle ID                                           |
| `VEHICLE_OCCUPIED`       | Requested seat is occupied; the other seat may still be free |
| `ALREADY_IN_VEHICLE`     | Entry requester already occupies either seat                 |
| `VEHICLE_TOO_FAR`        | Entry requester exceeds enter radius                         |
| `NOT_VEHICLE_DRIVER`     | Movement requester is not the current driver                 |
| `NOT_IN_VEHICLE`         | Exit requester occupies neither seat                         |
| `STALE_VEHICLE_REVISION` | Request revision differs from current revision               |
| `STALE_VEHICLE_SEQUENCE` | Duplicate or older movement sequence                         |
| `INVALID_VEHICLE_STATE`  | Movement numbers exceed configured limits                    |
| `VEHICLE_MOVING`         | Entry or exit attempted while accepted speed is nonzero      |
| `INVALID_EXIT_POSITION`  | Proposed exit is outside bounds or exit radius               |
| `PLAYER_DRIVING`         | Walking report from the driver                               |
| `PLAYER_IN_VEHICLE`      | Walking report from the passenger                            |

`NOT_JOINED`, `INVALID_MESSAGE`, and `RATE_LIMITED` remain applicable. This target contract replaces the entry error `ALREADY_DRIVING` with `ALREADY_IN_VEHICLE`.

## Frontend and backend acceptance checks

- Validate snapshots with two distinct joined occupants, explicit nullable passengerId, and driverless stopped passenger occupancy; reject invalid references, duplicate seats, malformed numbers and invalid seat names.
- Race entry for the same and different seats; verify one grant per revision, safe stale rejection, and no third occupant. Keep the total room cap at five.
- Verify late joins see both occupants, fixed model/appearance selections survive all releases, passengers follow the truck, and only the driver publishes movement.
- Verify passenger entry/exit resets the driver's sequence epoch without stuck pending controls, stale acknowledgements, unintended exit, or lost control. Old-epoch movement must be rejected.
- Verify independent stopped exits, blocked exit points, moving entry/exit rejection, and a passenger-exit/driver-movement race in both processing orders.
- Disconnect the passenger while driving: retain driver and motion, reset ordering, reject old reports. Disconnect the driver: stop the truck and retain passenger. Verify both-disconnect broadcast ordering and reconnect with a fresh ID.
- Verify walking resumes only for the released occupant with its existing walking sequence, occupant walking reports are rejected without consuming it, and chat remains available.
- Check frontend seat offsets/poses or hidden standing meshes, passenger camera following, local physics suspension, one character instance per player, and cleanup on release, disconnect and unmount. No extra GLB loads or sockets.
- Extend tests/multiplayer.test.mjs and backend protocol/occupancy tests, then verify with live browsers and the actual backend. Existing single-driver tests alone do not establish two-seat compatibility.

## Backend revision exhaustion

Entry is rejected with `INVALID_VEHICLE_STATE` when fewer than three safe revision increments remain. This reserves enough revisions to release both occupants without overflowing. Restart the backend to reset exhausted state.
