const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { initializeWebSocket } = require('../build/websocket.js');
const { parseClientMessage, createPlayer, applyPlayerMovement } = require('../build/game.js');

const appearance = { shirt: 2, pants: 1, hairstyle: 0, glasses: 1 };
const join = { type: 'player:join', payload: { name: 'Player', appearance } };

// Queue messages immediately so broadcasts arriving between assertions are retained.
function inbox(socket) {
  const messages = [];
  const waiting = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else messages.push(message);
  });
  return () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise((resolve) => waiting.push(resolve));
}

// Model validation must reject mismatches before a socket can create a player.
test('character selections normalize legacy joins and reject invalid combinations', () => {
  const parse = (payload) => parseClientMessage({ type: 'player:join', payload });
  assert.equal(parse(join.payload).payload.model, 'custom');
  for (const model of ['custom', 'person2', 'ceo']) {
    const payload = {
      name: ' Selected ',
      model,
      appearance: model === 'custom' ? appearance : null,
    };
    assert.deepEqual(parse(payload).payload, { ...payload, name: 'Selected' });
  }
  for (const payload of [
    { name: 'X', model: null, appearance },
    { name: 'X', model: '/models/evil.glb', appearance },
    { name: 'X', model: 'custom', appearance: null },
    { name: 'X', appearance: null },
    ...['person3', 'person2', 'ceo'].flatMap((model) => [
      { name: 'X', model, appearance },
      { name: 'X', model },
    ]),
  ])
    assert.equal(parse(payload), undefined);
  for (const model of ['person3', 'person2', 'ceo']) {
    const player = createPlayer(parse({ name: 'X', model, appearance: null }).payload);
    applyPlayerMovement(player, {
      sequence: 0,
      position: { x: 1, y: 0, z: 0 },
      rotation: 0,
      animation: 'Walk',
      model: 'custom',
      appearance,
    });
    assert.equal(player.model, model);
    assert.equal(player.appearance, null);
  }
});

test('validation rejects invalid customization and non-finite input', () => {
  assert.equal(
    parseClientMessage({
      ...join,
      payload: { ...join.payload, appearance: { ...appearance, shirt: 3 } },
    }),
    undefined,
  );
  assert.equal(
    parseClientMessage({
      type: 'player:move',
      payload: {
        sequence: 0,
        position: { x: Infinity, y: 0, z: 0 },
        rotation: 0,
        animation: 'Run',
      },
    }),
    undefined,
  );
  assert.equal(parseClientMessage({ type: 'player:appearance', payload: appearance }), undefined);
  const player = createPlayer(join.payload);
  const movement = {
    sequence: 42,
    position: { x: 10.5, y: 2, z: 4.2 },
    rotation: 1.57,
    animation: 'Run',
  };
  assert.equal(applyPlayerMovement(player, movement), true);
  assert.deepEqual(player.position, movement.position);
  assert.equal(player.rotation, movement.rotation);
  assert.equal(applyPlayerMovement(player, movement), false);
  assert.equal(parseClientMessage({ type: 'player:input', payload: {} }), undefined);
  for (const invalid of [
    { ...movement, sequence: -1 },
    { ...movement, sequence: 1.5 },
    { ...movement, rotation: NaN },
    { ...movement, animation: 'Jump' },
    { ...movement, position: null },
    { ...movement, position: { x: 0, y: '0', z: 0 } },
    { ...movement, position: { x: 0, y: 0, z: -Infinity } },
  ])
    assert.equal(parseClientMessage({ type: 'player:move', payload: invalid }), undefined);
});

test(
  'shared room initializes, synchronizes, enforces capacity, and removes disconnected players',
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    const wss = initializeWebSocket(server);
    const sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `ws://127.0.0.1:${server.address().port}/`;
    async function connect() {
      const socket = new WebSocket(url);
      sockets.push(socket);
      const next = inbox(socket);
      await once(socket, 'open');
      return { socket, next };
    }
    const first = await connect();
    first.socket.send(JSON.stringify(join));
    const init = await first.next();
    assert.equal(init.type, 'world:init');
    assert.deepEqual(init.payload.players[0].appearance, appearance);
    const second = await connect();
    second.socket.send(
      JSON.stringify({ ...join, payload: { name: 'Fixed', model: 'person2', appearance: null } }),
    );
    const secondInit = await second.next();
    assert.equal(secondInit.payload.players.length, 2);
    const joined = await first.next();
    assert.equal(joined.type, 'player:joined');
    assert.equal(joined.payload.player.model, 'person2');
    assert.equal(joined.payload.player.appearance, null);
    assert.equal(secondInit.payload.players[0].model, 'custom');
    first.socket.send(
      JSON.stringify({
        type: 'player:move',
        payload: {
          sequence: 42,
          position: { x: 10.5, y: 2, z: 4.2 },
          rotation: 1.57,
          animation: 'Run',
          id: 'spoofed',
        },
      }),
    );
    const update = await second.next();
    assert.equal(update.type, 'player:update');
    assert.deepEqual(update.payload.position, { x: 10.5, y: 2, z: 4.2 });
    assert.equal(update.payload.rotation, 1.57);
    assert.equal(update.payload.id, init.payload.playerId);
    assert.equal(update.payload.animation, 'Run');
    assert.equal(update.payload.sequence, 42);
    assert.equal('lastProcessedInput' in update.payload, false);
    // A chat reply acts as a barrier: the sender must not have received its own movement.
    first.socket.send(JSON.stringify({ type: 'chat:send', payload: { text: 'Barrier' } }));
    assert.equal((await first.next()).type, 'chat:message');
    assert.equal((await second.next()).type, 'chat:message');
    assert.equal('appearance' in update.payload, false);
    assert.equal('model' in update.payload, false);
    // Replays must fail, and unchanged reports must not produce peer updates.
    const report = (sequence) =>
      first.socket.send(
        JSON.stringify({
          type: 'player:move',
          payload: {
            sequence,
            position: update.payload.position,
            rotation: update.payload.rotation,
            animation: update.payload.animation,
          },
        }),
      );
    report(42);
    assert.equal((await first.next()).payload.code, 'INVALID_MESSAGE');
    for (let sequence = 43; sequence <= 61; sequence++) report(sequence);
    report(62);
    assert.equal((await first.next()).payload.code, 'RATE_LIMITED');
    second.socket.send(JSON.stringify({ type: 'chat:send', payload: { text: 'Peer barrier' } }));
    assert.equal((await second.next()).type, 'chat:message');
    assert.equal((await first.next()).type, 'chat:message');
    for (let i = 0; i < 3; i++) await connect();
    const rejected = await connect();
    assert.equal((await rejected.next()).payload.code, 'ROOM_FULL');
    assert.equal((await once(rejected.socket, 'close'))[0], 1013);
    const closed = once(first.socket, 'close');
    first.socket.close();
    await closed;
    let left;
    do {
      left = await second.next();
    } while (left.type !== 'player:left');
    assert.equal(left.payload.id, init.payload.playerId);
    const replacement = await connect();
    replacement.socket.send(JSON.stringify(join));
    assert.equal((await replacement.next()).payload.players.length, 2);
    replacement.socket.send(JSON.stringify(join));
    assert.equal((await replacement.next()).payload.code, 'ALREADY_JOINED');
    second.socket.send('invalid json');
    let error;
    do {
      error = await second.next();
    } while (error.type !== 'server:error');
    assert.equal(error.payload.code, 'INVALID_MESSAGE');
  },
);

test('chat validates Unicode length and rejects spoofed metadata', () => {
  const parse = (payload) => parseClientMessage({ type: 'chat:send', payload });
  for (const text of ['', '   ', 123, 'a'.repeat(201), '\u{1F600}'.repeat(201)]) {
    assert.equal(parse({ text }), undefined);
  }
  assert.equal(parse({ text: 'Hello', senderId: 'spoofed' }), undefined);
  assert.equal(parse({ text: 'Hello', timestamp: 0 }), undefined);
  assert.equal(parse({ text: '\u{1F600}'.repeat(200) }).payload.text, '\u{1F600}'.repeat(200));
  assert.equal(parse({ text: '  Hello  ' }).payload.text, 'Hello');
});

test(
  'chat requires joining, broadcasts authoritative identity, and limits accepted messages',
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    const wss = initializeWebSocket(server);
    const sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    async function connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
      sockets.push(socket);
      const next = inbox(socket);
      await once(socket, 'open');
      return { socket, next };
    }
    const first = await connect();
    const second = await connect();
    const send = (client, text) =>
      client.socket.send(JSON.stringify({ type: 'chat:send', payload: { text } }));
    send(first, 'Before joining');
    assert.equal((await first.next()).payload.code, 'NOT_JOINED');
    first.socket.send(JSON.stringify(join));
    const init = await first.next();
    second.socket.send(JSON.stringify(join));
    await second.next();
    await first.next();
    send(first, '   ');
    assert.equal((await first.next()).payload.code, 'INVALID_MESSAGE');
    const before = Date.now();
    send(first, '  Hello \u{1F600}  ');
    const message = await first.next();
    assert.equal(message.type, 'chat:message');
    assert.deepEqual(await second.next(), message);
    assert.equal(message.payload.senderId, init.payload.playerId);
    assert.equal(message.payload.senderName, join.payload.name);
    assert.equal(message.payload.text, 'Hello \u{1F600}');
    assert.match(message.payload.id, /^[0-9a-f-]{36}$/);
    assert.ok(message.payload.timestamp >= before && message.payload.timestamp <= Date.now());
    send(first, 'Too fast');
    assert.equal((await first.next()).payload.code, 'CHAT_RATE_LIMITED');
    // Cooldowns belong to the sender, not the room.
    send(second, 'Reply');
    const reply = await second.next();
    assert.equal(reply.payload.text, 'Reply');
    assert.deepEqual(await first.next(), reply);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    send(first, 'Later');
    const later = await first.next();
    assert.equal(later.payload.text, 'Later');
    assert.notEqual(later.payload.id, message.payload.id);
    assert.deepEqual(await second.next(), later);
  },
);
