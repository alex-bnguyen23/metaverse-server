const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { initializeWebSocket } = require('../build/websocket.js');
const { parseClientMessage, createPlayer } = require('../build/game.js');
const { SharedVehicle, vehicleConfig } = require('../build/vehicle.js');

const join = {
  type: 'player:join',
  payload: { name: 'Driver', appearance: { shirt: 0, pants: 0, hairstyle: 0, glasses: 0 } },
};
const position = { ...vehicleConfig.spawn.position };
const request = (type, payload = {}) => ({
  type,
  payload: {
    vehicleId: 'cybertruck-1',
    revision: 0,
    ...(type === 'vehicle:enter' ? { seat: 'driver' } : {}),
    ...payload,
  },
});
const movement = {
  revision: 1,
  sequence: 0,
  position,
  rotation: 1,
  speed: 4,
  steering: 0.1,
  wheelAngle: 12,
};

test('vehicle parsing validates every numeric field and strips spoofed identities', () => {
  for (const field of ['revision', 'sequence', 'rotation', 'speed', 'steering', 'wheelAngle']) {
    for (const value of [NaN, Infinity, '1', null]) {
      assert.equal(
        parseClientMessage(request('vehicle:move', { ...movement, [field]: value })),
        undefined,
      );
    }
  }
  for (const field of ['revision', 'sequence']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        parseClientMessage(request('vehicle:move', { ...movement, [field]: value })),
        undefined,
      );
    }
  }
  for (const point of [null, [], { x: 0, y: 0, z: Infinity }]) {
    assert.equal(
      parseClientMessage(request('vehicle:exit', { position: point, rotation: 0 })),
      undefined,
    );
  }
  const parsed = parseClientMessage(
    request('vehicle:move', { ...movement, driverId: 'fake', id: 'fake' }),
  );
  assert.equal('driverId' in parsed.payload, false);
  assert.equal('id' in parsed.payload, false);
});

test('vehicle transitions validate proximity, bounds, leases, limits, and exit atomically', () => {
  const truck = new SharedVehicle();
  const player = createPlayer(join.payload);
  assert.equal(truck.apply(player, request('vehicle:enter')), 'VEHICLE_TOO_FAR');
  player.position = { ...position };
  assert.equal(
    truck.apply(player, request('vehicle:enter', { vehicleId: 'unknown' })),
    'VEHICLE_NOT_FOUND',
  );
  assert.equal(truck.apply(player, request('vehicle:enter')), undefined);
  assert.equal(
    truck.apply(player, request('vehicle:enter', { revision: 1 })),
    'ALREADY_IN_VEHICLE',
  );
  const other = createPlayer(join.payload);
  other.position = { ...position };
  assert.equal(truck.apply(other, request('vehicle:enter', { revision: 1 })), 'VEHICLE_OCCUPIED');
  assert.equal(truck.apply(other, request('vehicle:move', movement)), 'NOT_VEHICLE_DRIVER');
  assert.equal(
    truck.apply(other, request('vehicle:exit', { revision: 1, position, rotation: 0 })),
    'NOT_IN_VEHICLE',
  );
  const before = JSON.stringify(truck.state);
  for (const invalid of [
    { speed: 10.01 },
    { speed: -4.01 },
    { steering: Math.PI / 6 + 0.01 },
    { position: { ...position, y: 26 } },
    { position: { ...position, x: -71 } },
  ]) {
    assert.equal(
      truck.apply(player, request('vehicle:move', { ...movement, ...invalid })),
      'INVALID_VEHICLE_STATE',
    );
    assert.equal(JSON.stringify(truck.state), before);
  }
  assert.equal(truck.apply(player, request('vehicle:move', movement)), undefined);
  assert.equal(truck.apply(player, request('vehicle:move', movement)), 'STALE_VEHICLE_SEQUENCE');
  assert.equal(
    truck.apply(player, request('vehicle:exit', { revision: 1, position, rotation: 0 })),
    'VEHICLE_MOVING',
  );
  assert.equal(
    truck.apply(player, request('vehicle:move', { ...movement, sequence: 1, speed: 0 })),
    undefined,
  );
  assert.equal(
    truck.apply(
      player,
      request('vehicle:exit', { revision: 1, position: { x: 0, y: 0, z: 0 }, rotation: 0 }),
    ),
    'INVALID_EXIT_POSITION',
  );
  assert.equal(truck.state.driverId, player.id);
  assert.equal(
    truck.apply(player, request('vehicle:exit', { revision: 1, position, rotation: 0 })),
    undefined,
  );
  assert.equal(truck.state.revision, 2);
  assert.equal(truck.state.wheelAngle, 12);
  assert.equal(truck.state.steering, 0);
  assert.equal(truck.apply(other, request('vehicle:enter', { revision: 2 })), undefined);
  assert.equal(
    truck.apply(player, request('vehicle:move', { ...movement, sequence: 9 })),
    'STALE_VEHICLE_REVISION',
  );
  assert.equal(
    truck.apply(other, request('vehicle:move', { ...movement, revision: 3 })),
    undefined,
  );
});

// Keep an inbox attached before open so back-to-back occupancy broadcasts cannot be lost.
function inbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  return () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise((resolve) => waiters.push(resolve));
}

test(
  'vehicle sockets serialize entry, echo driving, initialize late joiners, and release on disconnect',
  { timeout: 8000 },
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
      return { socket, next, send: (message) => socket.send(JSON.stringify(message)) };
    }
    const first = await connect();
    first.send(request('vehicle:enter'));
    assert.equal((await first.next()).payload.code, 'NOT_JOINED');
    first.send({ ...join, payload: { name: 'CEO', model: 'ceo', appearance: null } });
    const init = await first.next();
    assert.equal(init.payload.vehicles.length, 1);
    assert.deepEqual(init.payload.vehicles[0].position, position);
    assert.equal(init.payload.vehicles[0].rotation, Math.PI / 2);
    const second = await connect();
    second.send(join);
    await second.next();
    await first.next();
    const walk = (sequence) => ({
      type: 'player:move',
      payload: { sequence, position, rotation: 0, animation: 'Idle' },
    });
    first.send(walk(4));
    await second.next();
    second.send(walk(4));
    await first.next();
    first.send(request('vehicle:enter'));
    second.send(request('vehicle:enter'));
    assert.equal((await first.next()).type, 'vehicle:occupied');
    assert.equal((await second.next()).type, 'vehicle:occupied');
    assert.equal((await second.next()).payload.code, 'STALE_VEHICLE_REVISION');
    first.send(walk(5));
    assert.equal((await first.next()).payload.code, 'PLAYER_DRIVING');
    first.send(request('vehicle:move', movement));
    const echo = await first.next();
    assert.equal(echo.type, 'vehicle:update');
    assert.deepEqual(await second.next(), echo);
    assert.equal(echo.payload.vehicle.driverId, init.payload.playerId);
    assert.equal('appearance' in echo.payload.vehicle, false);
    first.send(request('vehicle:move', movement));
    const stale = await first.next();
    assert.equal(stale.payload.code, 'STALE_VEHICLE_SEQUENCE');
    assert.equal(stale.payload.revision, 1);
    const third = await connect();
    third.send(join);
    const late = await third.next();
    assert.deepEqual(late.payload.vehicles[0], echo.payload.vehicle);
    assert.deepEqual(
      late.payload.players.find((p) => p.id === init.payload.playerId).position,
      position,
    );
    assert.equal(late.payload.players.find((p) => p.id === init.payload.playerId).model, 'ceo');
    await first.next();
    await second.next();
    first.send(request('vehicle:move', { ...movement, sequence: 1, speed: 0 }));
    for (const client of [first, second, third])
      assert.equal((await client.next()).type, 'vehicle:update');
    first.send(request('vehicle:exit', { revision: 1, position, rotation: 0 }));
    for (const client of [first, second, third]) {
      const release = await client.next();
      assert.equal(release.type, 'vehicle:released');
      assert.equal(release.payload.reason, 'exit');
      assert.equal(release.payload.player.model, 'ceo');
      assert.equal(release.payload.player.appearance, null);
      assert.equal(release.payload.vehicle.revision, 2);
    }
    // Reusing the walking sequence rejected while seated proves it was not consumed.
    first.send({ ...walk(5), payload: { ...walk(5).payload, rotation: 0.5 } });
    for (const client of [second, third]) assert.equal((await client.next()).type, 'player:update');
    first.send(request('vehicle:enter', { revision: 2 }));
    assert.equal((await first.next()).payload.code, 'RATE_LIMITED');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    first.send(request('vehicle:enter', { revision: 2 }));
    for (const client of [first, second, third])
      assert.equal((await client.next()).type, 'vehicle:occupied');
    first.send(request('vehicle:move', { ...movement, revision: 3, sequence: 0 }));
    for (const client of [first, second, third])
      assert.equal((await client.next()).type, 'vehicle:update');
    // A fresh lease resets ordering, but its rolling traffic limit still applies.
    for (let sequence = 1; sequence < 20; sequence++) {
      first.send(request('vehicle:move', { ...movement, revision: 3, sequence }));
      for (const client of [first, second, third])
        assert.equal((await client.next()).type, 'vehicle:update');
    }
    first.send(request('vehicle:move', { ...movement, revision: 3, sequence: 20 }));
    assert.equal((await first.next()).payload.code, 'RATE_LIMITED');
    first.socket.close();
    for (const client of [second, third]) {
      const release = await client.next();
      assert.equal(release.type, 'vehicle:released');
      assert.equal(release.payload.reason, 'disconnect');
      assert.equal(release.payload.player, null);
      assert.equal(release.payload.vehicle.speed, 0);
      assert.equal(release.payload.vehicle.wheelAngle, 12);
      assert.equal((await client.next()).type, 'player:left');
    }
    const reconnect = await connect();
    reconnect.send(join);
    const fresh = await reconnect.next();
    assert.notEqual(fresh.payload.playerId, init.payload.playerId);
    assert.equal(fresh.payload.vehicles[0].driverId, null);
    assert.equal(fresh.payload.vehicles[0].revision, 4);
  },
);

// Passenger transitions must change only the requested seat and invalidate old movement epochs.
test('passenger seats support independent exits, synchronization and disconnect epochs', () => {
  for (const seat of [undefined, null, 'rear', 0]) {
    assert.equal(parseClientMessage(request('vehicle:enter', { seat })), undefined);
  }
  const truck = new SharedVehicle();
  const driver = createPlayer(join.payload);
  const passenger = createPlayer({ name: 'Passenger', model: 'ceo', appearance: null });
  const third = createPlayer(join.payload);
  const players = new Map([driver, passenger, third].map((p) => [p.id, p]));
  for (const p of players.values()) p.position = { ...position };
  const enter = (p, seat, revision = truck.state.revision) =>
    truck.apply(p, request('vehicle:enter', { seat, revision }));
  const move = (sequence, speed = 0, revision = truck.state.revision) =>
    truck.apply(
      driver,
      request('vehicle:move', {
        ...movement,
        position: { ...position, z: 1 },
        revision,
        sequence,
        speed,
      }),
    );
  const exit = (p) =>
    truck.apply(
      p,
      request('vehicle:exit', { revision: truck.state.revision, position, rotation: 2 }),
    );
  assert.equal(truck.state.passengerId, null);
  assert.equal(enter(passenger, 'passenger'), undefined);
  assert.equal(truck.state.driverId, null);
  assert.equal(enter(driver, 'driver', 0), 'STALE_VEHICLE_REVISION');
  assert.equal(enter(driver, 'driver'), undefined);
  assert.equal(enter(passenger, 'driver'), 'ALREADY_IN_VEHICLE');
  assert.equal(enter(third, 'passenger'), 'VEHICLE_OCCUPIED');
  assert.equal(
    truck.apply(passenger, request('vehicle:move', { ...movement, revision: 2 })),
    'NOT_VEHICLE_DRIVER',
  );
  assert.equal(move(7, 4), undefined);
  truck.syncOccupants(players);
  for (const p of [driver, passenger]) {
    assert.deepEqual(p.position, truck.state.position);
    assert.equal(p.rotation, truck.state.rotation);
    assert.equal(p.animation, 'Idle');
  }
  assert.equal(exit(passenger), 'VEHICLE_MOVING');
  assert.equal(move(8), undefined);
  assert.equal(exit(driver), undefined);
  assert.equal(truck.state.passengerId, passenger.id);
  assert.equal(truck.state.driverId, null);
  assert.equal(passenger.model, 'ceo');
  assert.equal(enter(driver, 'driver'), undefined);
  assert.equal(move(0, 4), undefined);
  const revision = truck.state.revision;
  truck.release(passenger.id, true);
  assert.equal(truck.state.revision, revision + 1);
  assert.equal(truck.state.speed, 4);
  assert.equal(truck.state.steering, 0.1);
  assert.equal(move(1, 4, revision), 'STALE_VEHICLE_REVISION');
  assert.equal(move(0), undefined);
  passenger.position = { ...truck.state.position };
  assert.equal(enter(passenger, 'passenger'), undefined);
  assert.equal(move(0, 4), undefined);
  truck.release(driver.id, true);
  assert.equal(truck.state.speed, 0);
  assert.equal(truck.state.steering, 0);
  assert.equal(truck.state.wheelAngle, 12);
  assert.equal(truck.state.passengerId, passenger.id);
  assert.equal(exit(passenger), undefined);
  assert.equal(passenger.rotation, 2);
  assert.equal(passenger.appearance, null);
  const before = truck.state.revision;
  truck.release(third.id, true);
  assert.equal(truck.state.revision, before);
  truck.state.revision = Number.MAX_SAFE_INTEGER - 2;
  assert.equal(enter(driver, 'driver'), 'INVALID_VEHICLE_STATE');
});

// Exercise wire payloads as well as controller state so passenger grants cannot regress silently.
test(
  'passenger sockets reject walking and initialize both occupants',
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    const wss = initializeWebSocket(server);
    const clients = [];
    t.after(async () => {
      for (const c of clients) c.socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    async function connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
      const next = inbox(socket);
      const c = { socket, next, send: (m) => socket.send(JSON.stringify(m)) };
      clients.push(c);
      await once(socket, 'open');
      c.send(join);
      c.init = (await next()).payload;
      for (const peer of clients.slice(0, -1))
        assert.equal((await peer.next()).type, 'player:joined');
      return c;
    }
    const driver = await connect();
    const passenger = await connect();
    const walk = {
      type: 'player:move',
      payload: { sequence: 0, position, rotation: 0, animation: 'Walk' },
    };
    driver.send(walk);
    await passenger.next();
    passenger.send(walk);
    await driver.next();
    driver.send(request('vehicle:enter'));
    for (const c of clients) await c.next();
    passenger.send(request('vehicle:enter', { revision: 1, seat: 'passenger' }));
    for (const c of clients) {
      const grant = await c.next();
      assert.equal(grant.payload.seat, 'passenger');
      assert.equal(grant.payload.playerId, passenger.init.playerId);
      assert.equal(grant.payload.vehicle.passengerId, passenger.init.playerId);
    }
    passenger.send({ ...walk, payload: { ...walk.payload, sequence: 1 } });
    assert.equal((await passenger.next()).payload.code, 'PLAYER_IN_VEHICLE');
    driver.send(
      request('vehicle:move', { ...movement, revision: 2, position: { ...position, z: 1 } }),
    );
    for (const c of clients) assert.equal((await c.next()).type, 'vehicle:update');
    const late = await connect();
    for (const id of [driver.init.playerId, passenger.init.playerId]) {
      assert.deepEqual(late.init.players.find((p) => p.id === id).position, { ...position, z: 1 });
    }
    passenger.socket.close();
    for (const c of [driver, late]) {
      const release = await c.next();
      assert.equal(release.payload.seat, 'passenger');
      assert.equal(release.payload.playerId, passenger.init.playerId);
      assert.equal(release.payload.vehicle.speed, 4);
      assert.equal(release.payload.vehicle.revision, 3);
      assert.equal((await c.next()).type, 'player:left');
    }
    driver.send(request('vehicle:move', { ...movement, revision: 3, sequence: 0 }));
    for (const c of [driver, late]) assert.equal((await c.next()).type, 'vehicle:update');
  },
);
