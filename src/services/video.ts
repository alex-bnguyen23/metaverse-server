import { FramePictureError } from './frame-pictures.js';

type Box = { type: string; data: Buffer };

/** Walks only bounded MP4 metadata; media payloads are never decoded on the game thread. */
function boxes(buffer: Buffer): Box[] {
  const result: Box[] = [];
  for (let offset = 0; offset < buffer.length;) {
    if (result.length >= 10_000 || buffer.length - offset < 8) throw invalidVideo();
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (buffer.length - offset < 16) throw invalidVideo();
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = buffer.length - offset;
    if (!Number.isSafeInteger(size) || size < header || size > buffer.length - offset)
      throw invalidVideo();
    result.push({ type, data: buffer.subarray(offset + header, offset + size) });
    offset += size;
  }
  return result;
}

function invalidVideo(): FramePictureError {
  return new FramePictureError(400, 'INVALID_VIDEO', 'Choose a valid non-fragmented MP4 video.');
}

/** Validates MP4 headers without a transcoder; original audio, metadata and pixels are retained. */
export function validateVideo(buffer: Buffer): Buffer {
  if (buffer.length > 50 * 1024 * 1024) {
    throw new FramePictureError(413, 'FILE_TOO_LARGE', 'Choose a video up to 50 MiB.');
  }
  try {
    const root = boxes(buffer);
    const fileType = root.find((box) => box.type === 'ftyp')?.data;
    const movie = root.find((box) => box.type === 'moov')?.data;
    if (
      !fileType ||
      fileType.length < 8 ||
      !movie ||
      !root.some((box) => box.type === 'mdat' && box.data.length > 0)
    )
      throw invalidVideo();
    const brands = [fileType.toString('ascii', 0, 4)];
    for (let offset = 8; offset + 4 <= fileType.length; offset += 4)
      brands.push(fileType.toString('ascii', offset, offset + 4));
    if (!brands.some((brand) => ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand))) {
      throw new FramePictureError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use an H.264 MP4 video.');
    }
    const metadata = boxes(movie);
    // Fragmented/live movies do not have reliable complete-file duration in these headers.
    if (metadata.some((box) => box.type === 'mvex') || root.some((box) => box.type === 'moof'))
      throw invalidVideo();
    const header = metadata.find((box) => box.type === 'mvhd')?.data;
    if (!header || header.length < 20 || ![0, 1].includes(header[0])) throw invalidVideo();
    const versionOne = header[0] === 1;
    if (versionOne && header.length < 32) throw invalidVideo();
    const timescale = header.readUInt32BE(versionOne ? 20 : 12);
    const duration = versionOne ? Number(header.readBigUInt64BE(24)) : header.readUInt32BE(16);
    if (!timescale || !Number.isSafeInteger(duration) || duration <= 0) throw invalidVideo();
    if (duration / timescale > 60)
      throw new FramePictureError(413, 'VIDEO_TOO_LARGE', 'Videos must be at most 60 seconds.');
    let videoTracks = 0;
    for (const track of metadata.filter((box) => box.type === 'trak')) {
      const media = boxes(track.data).find((box) => box.type === 'mdia');
      if (!media) throw invalidVideo();
      const children = boxes(media.data);
      const handler = children.find((box) => box.type === 'hdlr')?.data;
      if (!handler || handler.length < 12) throw invalidVideo();
      if (handler.toString('ascii', 8, 12) !== 'vide') continue;
      videoTracks++;
      const info = children.find((box) => box.type === 'minf');
      const table = info && boxes(info.data).find((box) => box.type === 'stbl');
      const description = table && boxes(table.data).find((box) => box.type === 'stsd')?.data;
      if (!description || description.length < 8 || description.readUInt32BE(4) !== 1)
        throw invalidVideo();
      const entries = boxes(description.subarray(8));
      const entry = entries[0];
      if (entries.length !== 1 || !entry || entry.type !== 'avc1')
        throw new FramePictureError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use an H.264 MP4 video.');
      if (entry.data.length < 78) throw invalidVideo();
      const width = entry.data.readUInt16BE(24);
      const height = entry.data.readUInt16BE(26);
      if (!width || !height) throw invalidVideo();
      if (width > 3840 || height > 2160)
        throw new FramePictureError(413, 'VIDEO_TOO_LARGE', 'Videos must be at most 3840 by 2160.');
      if (
        !boxes(entry.data.subarray(78)).some((box) => box.type === 'avcC' && box.data.length >= 7)
      )
        throw invalidVideo();
    }
    if (videoTracks !== 1) throw invalidVideo();
    return buffer;
  } catch (error) {
    if (error instanceof FramePictureError) throw error;
    throw invalidVideo();
  }
}
