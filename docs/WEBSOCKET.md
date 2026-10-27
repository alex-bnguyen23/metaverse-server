# WebSocket client guide

Connect to `ws://localhost:3000/` (use your configured port and `wss://` behind HTTPS). All messages use `{ "type": "...", "payload": { ... } }`.

Send `player:join` within 10 seconds with `{ name, model, appearance }`. Names are trimmed and must contain 1-24 characters. Model and appearance stay fixed for the session. Use `custom` with valid appearance, or `person2` / `ceo` with explicit `appearance: null`. Legacy joins omitting model normalize to `custom` with valid appearance. See [PROTOCOLS.md](PROTOCOLS.md) for the full player schemas.

After `world:init`, send `player:move` with `{ sequence, position: { x, y, z }, rotation, animation }`. Sequence numbers are nonnegative safe integers and must increase. Position and rotation must be finite numbers; animation must be `Idle`, `Walk`, or `Run`.

The frontend calculates movement, physics, and collisions. The server stores accepted values without modifying them and forwards changed states to other joined players, excluding the sender. There is no simulation loop or movement timeout. Send only changes, including a final `Idle` state when stopping. A rolling limit of 20 movement messages per second is enforced per session with `RATE_LIMITED` errors. No coordinate bounds are currently configured; all finite coordinates are accepted.

| Event           | Payload                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `world:init`    | `{ playerId, players, vehicles }`, including yourself, models and appearances |
| `player:joined` | `{ player }`, including model and appearance                                  |
| `player:update` | `{ id, sequence, position, rotation, animation }`                             |
| `player:left`   | `{ id }`                                                                      |
| `chat:message`  | `{ id, senderId, senderName, text, timestamp }`                               |
| `server:error`  | `{ code, message }`                                                           |

## Chat

The implemented backend model-selection contract is documented in [CHARACTER_SELECTION.md](CHARACTER_SELECTION.md). It adds a session-fixed model ID, nullable appearance for fixed models, and selection fields in full player snapshots. Verify frontend compatibility before enabling fixed-model selection.

After joining, send:

```json
{ "type": "chat:send", "payload": { "text": "Hello everyone!" } }
```

The server trims text, accepts up to 200 Unicode code points, and permits one accepted message per player per second. Sender metadata must not be included. All joined players, including the sender, receive the accepted message. No backend history is retained. Render text as plain text and wait for the server broadcast before displaying your own message. See [CHAT.md](CHAT.md) for details and errors.

## Vehicles

`world:init` includes the current shared `cybertruck-1`, initially at `(-35, 0, 0)` with heading `Math.PI / 2`. See [PROTOCOLS.md](PROTOCOLS.md#vehicle-protocol-extension) for schemas, shared limits, and frontend integration requirements.

- Send `vehicle:enter` with `{ vehicleId, revision }` within 3 world units. Wait for `vehicle:occupied` before driving.
- Send `vehicle:move` with `{ vehicleId, revision, sequence, position, rotation, speed, steering, wheelAngle }` at up to 20 Hz. All joined clients, including the driver, receive `vehicle:update` with `{ vehicle, sequence }`.
- Stop with an accepted `speed: 0` report, then send `vehicle:exit` with `{ vehicleId, revision, position, rotation }`. The frontend must collision-check the exit point within 3 units. Wait for `vehicle:released` before resuming walking.
- Enter/exit share a separate limit of 2 requests per second. Walking while driving receives `PLAYER_DRIVING` without consuming the walking sequence. Continue that sequence after exit; vehicle sequences start at zero for each new driving lease.
- Disconnect releases occupancy and stops the vehicle before broadcasting `player:left`. The parked transform and wheel angle survive an empty room until server restart.

Vehicle rejections use `server:error`; processed vehicle requests include `requestType`, `vehicleId`, and the current `revision`. Malformed requests use the existing `INVALID_MESSAGE` response. No backend vehicle physics or collision simulation runs.

## Connection handling

Five connected clients may reserve slots, including clients waiting to join. Excess clients receive `ROOM_FULL` and close with code 1013. Binary messages and traffic above 120 messages per second close with code 1008. Payloads are limited to 4 KiB. Other invalid requests receive `server:error`. Reconnect with a new join and appearance after disconnecting.
