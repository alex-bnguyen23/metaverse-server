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

test('video metadata persists across mixed replacements and downloads support ranges and HEAD', async (t) => {
  const { url, directory } = await fixture(t);
  const store = new FramePictureStore(directory);
  const bytes = Buffer.from('0123456789');
  const video = await store.replace('left', bytes, 'video');
  assert.equal(video.mediaType, 'video');
  assert.equal(video.imageUrl, '/api/frame-pictures/left/videos/1.mp4');
  assert.equal((await new FramePictureStore(directory).list())[0].mediaType, 'video');
  const endpoint = `${url}/left/videos/1.mp4`;
  const partial = await fetch(endpoint, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(partial.headers.get('content-type'), 'video/mp4');
  assert.equal(await partial.text(), '2345');
  const suffix = await fetch(endpoint, { headers: { Range: 'bytes=-3' } });
  assert.equal(await suffix.text(), '789');
  const invalid = await fetch(endpoint, { headers: { Range: 'bytes=10-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  const head = await fetch(endpoint, { method: 'HEAD' });
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${url}/left/images/1.jpg`)).status, 404);
  const image = await store.replace('left', Buffer.from('jpeg'));
  assert.equal(image.revision, 2);
  assert.equal(image.mediaType, 'image');
  assert.equal((await fetch(endpoint)).status, 200);
});

test('legacy image manifests remain readable and unsupported media is rejected', async (t) => {
  const { url, directory } = await fixture(t);
  const store = new FramePictureStore(directory);
  await store.replace('left', Buffer.from('jpeg'));
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest[0].mediaType;
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await store.list())[0].revision, 1);
  const form = new FormData();
  form.append('image', new Blob(['bad'], { type: 'text/html' }), 'clip.mp4');
  const response = await fetch(`${url}/left`, { method: 'PUT', body: form });
  assert.equal(response.status, 415);
  assert.equal((await store.list())[0].revision, 1);
});

// Synthetic MP4 metadata exercises validation without claiming compressed samples decode.
function mp4Fixture({ duration = 1000, width = 1280, height = 720, codec = 'avc1' } = {}) {
  const box = (type, ...parts) => {
    const payload = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8);
    header.write(type, 4);
    return Buffer.concat([header, payload]);
  };
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1000, 12);
  movieHeader.writeUInt32BE(duration, 16);
  const handler = Buffer.alloc(24);
  handler.write('vide', 8);
  const sample = Buffer.alloc(78);
  sample.writeUInt16BE(width, 24);
  sample.writeUInt16BE(height, 26);
  const count = Buffer.alloc(8);
  count.writeUInt32BE(1, 4);
  const description = box(
    'stsd',
    count,
    box(codec, sample, box('avcC', Buffer.from([1, 66, 0, 30, 255, 225, 0]))),
  );
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom', 'binary')),
    box(
      'moov',
      box('mvhd', movieHeader),
      box('trak', box('mdia', box('hdlr', handler), box('minf', box('stbl', description)))),
    ),
    box('mdat', Buffer.from([0, 0, 0, 1])),
  ]);
}

test('direct MP4 uploads preserve original bytes and reject invalid metadata without video tools', async (t) => {
  const { url } = await fixture(t);
  const send = (bytes, type = 'video/mp4') => {
    const form = new FormData();
    form.append('image', new Blob([bytes], { type }), 'clip.mp4');
    return fetch(`${url}/left`, { method: 'PUT', body: form });
  };
  const clip = mp4Fixture();
  const accepted = await send(clip);
  assert.equal(accepted.status, 200);
  const { frame } = await accepted.json();
  assert.equal(frame.mediaType, 'video');
  const download = await fetch(`${url}/left/videos/1.mp4`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), clip);
  assert.equal((await send(Buffer.from('not an mp4'))).status, 400);
  assert.equal((await send(mp4Fixture({ duration: 60001 }))).status, 413);
  assert.equal((await send(mp4Fixture({ width: 3841 }))).status, 413);
  assert.equal((await send(clip, 'video/webm')).status, 415);
  assert.equal((await (await fetch(url)).json()).frames[0].revision, 1);
});

test('MP4 validation rejects truncation, unsafe box lengths and unsupported codecs', () => {
  const { validateVideo } = require('../build/services/video.js');
  const clip = mp4Fixture();
  for (const bytes of [clip.subarray(0, 7), clip.subarray(0, clip.length - 1), Buffer.alloc(20)]) {
    assert.throws(() => validateVideo(bytes), { code: 'INVALID_VIDEO' });
  }
  assert.throws(() => validateVideo(mp4Fixture({ codec: 'hvc1' })), {
    code: 'UNSUPPORTED_MEDIA_TYPE',
  });
  assert.throws(() => validateVideo(mp4Fixture({ duration: 0 })), { code: 'INVALID_VIDEO' });
});
