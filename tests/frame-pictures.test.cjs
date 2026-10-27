const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const { createFramePictureRouter } = require('../build/routes/frame-pictures.js');
const { FramePictureStore } = require('../build/services/frame-pictures.js');

// Keep test storage inside the project boundary, including cleanup targets.
async function fixture(t) {
  const directory = await mkdtemp(path.join(process.cwd(), '.frame-test-'));
  const app = express();
  app.use('/api/frame-pictures', createFramePictureRouter(directory));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}/api/frame-pictures` };
}

async function upload(url, bytes, extra) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), 'untrusted.png');
  if (extra) form.append('extra', 'rejected');
  return fetch(`${url}/left`, { method: 'PUT', body: form });
}

test('uploads normalize images, retain old revisions, and persist across store restarts', async (t) => {
  const { url, directory } = await fixture(t);
  const initial = await (await fetch(url)).json();
  assert.deepEqual(
    initial.frames.map((frame) => frame.revision),
    [0, 0],
  );
  const png = await sharp({ create: { width: 10, height: 20, channels: 4, background: 'red' } })
    .png()
    .toBuffer();
  for (let revision = 1; revision <= 2; revision++) {
    const response = await upload(url, png);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal((await response.json()).frame.revision, revision);
  }
  const response = await fetch(`${url}/left/images/1.jpg`);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.match(response.headers.get('cache-control'), /immutable/);
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
  const frames = await new FramePictureStore(directory).list();
  assert.deepEqual(
    frames.map((frame) => frame.revision),
    [2, 0],
  );
});

test('invalid multipart, corrupt images, extra fields and oversized files preserve metadata', async (t) => {
  const { url } = await fixture(t);
  assert.equal((await upload(url, Buffer.from('not an image'))).status, 400);
  assert.equal((await upload(url, Buffer.from('x'), true)).status, 400);
  const malformed = await fetch(`${url}/left`, {
    method: 'PUT',
    headers: { 'Content-Type': 'multipart/form-data' },
    body: 'broken',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await upload(url, Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await fetch(`${url}/invalid`, { method: 'PUT' })).status, 404);
  const limited = await upload(url, Buffer.from('x'));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.deepEqual(
    (await (await fetch(url)).json()).frames.map((frame) => frame.revision),
    [0, 0],
  );
});

test('manifest lock preserves both frames and corruption fails closed', async (t) => {
  const { directory } = await fixture(t);
  const store = new FramePictureStore(directory);
  await Promise.all([
    store.replace('left', Buffer.from('a')),
    store.replace('right', Buffer.from('b')),
    store.replace('left', Buffer.from('c')),
  ]);
  assert.deepEqual(
    (await store.list()).map((frame) => frame.revision),
    [2, 1],
  );
  assert.equal((await readFile(path.join(directory, 'left-1.jpg'))).toString(), 'a');
  await writeFile(path.join(directory, 'manifest.json'), '{}');
  await assert.rejects(store.list());
});
