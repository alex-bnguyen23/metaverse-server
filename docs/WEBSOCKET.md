# WebSocket client guide

Connect to `ws://localhost:3000/` (use your configured port and `wss://` behind HTTPS). All messages use `{ "type": "...", "payload": { ... } }`.

Send `player:join` within 10 seconds with `{ name, appearance }`. Names are trimmed and must contain 1-24 characters. Appearance stays fixed for the session. See [PROTOCOLS.md](PROTOCOLS.md) for the full player schemas.

After `world:init`, send `player:move` with `{ sequence, position: { x, y, z }, rotation, animation }`. Sequence numbers are nonnegative safe integers and must increase. Position and rotation must be finite numbers; animation must be `Idle`, `Walk`, or `Run`.

The frontend calculates movement, physics, and collisions. The server stores accepted values without modifying them and forwards changed states to other joined players, excluding the sender. There is no simulation loop or movement timeout. Send only changes, including a final `Idle` state when stopping. A rolling limit of 20 movement messages per second is enforced per session with `RATE_LIMITED` errors. No coordinate bounds are currently configured; all finite coordinates are accepted.

| Event           | Payload                                                     |
| --------------- | ----------------------------------------------------------- |
| `world:init`    | `{ playerId, players }`, including yourself and appearances |
| `player:joined` | `{ player }`, including appearance                          |
| `player:update` | `{ id, sequence, position, rotation, animation }`           |
| `player:left`   | `{ id }`                                                    |
| `chat:message`  | `{ id, senderId, senderName, text, timestamp }`             |
| `server:error`  | `{ code, message }`                                         |

## Chat

After joining, send:

```json
{ "type": "chat:send", "payload": { "text": "Hello everyone!" } }
```

The server trims text, accepts up to 200 Unicode code points, and permits one accepted message per player per second. Sender metadata must not be included. All joined players, including the sender, receive the accepted message. No backend history is retained. Render text as plain text and wait for the server broadcast before displaying your own message. See [CHAT.md](CHAT.md) for details and errors.

## Connection handling

Five connected clients may reserve slots, including clients waiting to join. Excess clients receive `ROOM_FULL` and close with code 1013. Binary messages and traffic above 120 messages per second close with code 1008. Payloads are limited to 4 KiB. Other invalid requests receive `server:error`. Reconnect with a new join and appearance after disconnecting.
