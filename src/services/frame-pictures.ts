import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export type FrameId = 'left' | 'right';
export type FramePicture = {
  frameId: FrameId;
  revision: number;
  imageUrl: string | null;
  updatedAt: number | null;
};

/** Carries public error details without exposing decoder errors or disk paths. */
export class FramePictureError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Restricts identifiers before they can influence storage paths. */
export function isFrameId(value: unknown): value is FrameId {
  return value === 'left' || value === 'right';
}

/** Normalizes trusted decoded pixels; uploaded originals are never published. */
export async function normalizeImage(buffer: Buffer): Promise<Buffer> {
  try {
    const image = sharp(buffer, { limitInputPixels: 20_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) {
      throw new FramePictureError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Use JPEG, PNG or WebP.');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new FramePictureError(400, 'INVALID_IMAGE', 'Animated images are not supported.');
    }
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8192 ||
      metadata.height > 8192 ||
      metadata.width * metadata.height > 20_000_000
    ) {
      throw new FramePictureError(413, 'IMAGE_TOO_LARGE', 'Image dimensions exceed the limits.');
    }
    return await image
      .rotate()
      .resize(1280, 720, { fit: 'contain', background: '#151515' })
      .flatten({ background: '#151515' })
      .jpeg({ quality: 85 })
      .timeout({ seconds: 15 })
      .toBuffer();
  } catch (error) {
    if (error instanceof FramePictureError) throw error;
    if (error instanceof Error && error.message.includes('pixel limit')) {
      throw new FramePictureError(413, 'IMAGE_TOO_LARGE', 'Image dimensions exceed the limits.');
    }
    throw new FramePictureError(400, 'INVALID_IMAGE', 'Choose a valid JPEG, PNG or WebP image.');
  }
}

/** Single-instance manifest storage serializes replacements across both frames. */
export class FramePictureStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  private async snapshot(): Promise<FramePicture[]> {
    await mkdir(this.directory, { recursive: true });
    const manifest = path.join(this.directory, 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(manifest, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Only initialize genuinely empty storage; an orphan JPEG signals a failed commit.
      if ((await readdir(this.directory)).some((name) => !name.endsWith('.tmp')))
        throw new Error('Missing manifest');
      const frames = ['left', 'right'].map((frameId) => ({
        frameId: frameId as FrameId,
        revision: 0,
        imageUrl: null,
        updatedAt: null,
      }));
      await this.writeManifest(frames);
      return frames;
    }
    const frames: unknown = JSON.parse(raw);
    if (!Array.isArray(frames) || frames.length !== 2) throw new Error('Invalid manifest');
    for (const [index, frame] of frames.entries()) {
      const id = index === 0 ? 'left' : 'right';
      if (frame?.frameId !== id || !Number.isSafeInteger(frame.revision) || frame.revision < 0)
        throw new Error('Invalid frame');
      if (frame.revision === 0) {
        if (frame.imageUrl !== null || frame.updatedAt !== null)
          throw new Error('Invalid empty frame');
      } else {
        if (
          frame.imageUrl !== this.url(id, frame.revision) ||
          !Number.isSafeInteger(frame.updatedAt) ||
          frame.updatedAt < 0
        )
          throw new Error('Invalid metadata');
        await readFile(this.imagePath(id, frame.revision));
      }
    }
    await this.cleanup(frames as FramePicture[]);
    return frames as FramePicture[];
  }

  private async cleanup(frames: FramePicture[]): Promise<void> {
    // Delay orphan/history deletion so in-flight readers keep their immutable bytes.
    for (const name of await readdir(this.directory)) {
      const match = /^(left|right)-(\d+)\.jpg$/.exec(name);
      if (!match && !/^[\da-f-]+\.tmp$/.test(name)) continue;
      if (match) {
        const current = frames[match[1] === 'left' ? 0 : 1].revision;
        const revision = Number(match[2]);
        if (revision === current || revision === current - 1) continue;
      }
      const filename = path.join(this.directory, name);
      if (Date.now() - (await stat(filename)).mtimeMs >= 60_000) await unlink(filename);
    }
  }

  private url(id: FrameId, revision: number): string {
    return `/api/frame-pictures/${id}/images/${revision}.jpg`;
  }
  private imagePath(id: FrameId, revision: number): string {
    return path.join(this.directory, `${id}-${revision}.jpg`);
  }

  /** Returns one committed snapshot; corruption never resets revision counters. */
  async list(): Promise<FramePicture[]> {
    const operation = this.queue.then(() => this.snapshot());
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async syncDirectory(): Promise<void> {
    // Windows cannot open directory handles with Node; POSIX deployments flush renames.
    if (process.platform === 'win32') return;
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async writeManifest(frames: FramePicture[]): Promise<void> {
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx');
      try {
        await file.writeFile(JSON.stringify(frames));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path.join(this.directory, 'manifest.json'));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** Publishes immutable bytes before atomically replacing the shared manifest. */
  async replace(id: FrameId, jpeg: Buffer): Promise<FramePicture> {
    const operation = this.queue.then(async () => {
      const frames = await this.snapshot();
      const index = id === 'left' ? 0 : 1;
      const revision = frames[index].revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Revision exhausted');
      const frame: FramePicture = {
        frameId: id,
        revision,
        imageUrl: this.url(id, revision),
        updatedAt: Date.now(),
      };
      // Exclusive creation prevents a failed earlier commit from overwriting immutable bytes.
      const imagePath = this.imagePath(id, revision);
      const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
      let published = false;
      try {
        const file = await open(temporary, 'wx');
        try {
          await file.writeFile(jpeg);
          await file.sync();
        } finally {
          await file.close();
        }
        await link(temporary, imagePath);
        published = true;
        await this.syncDirectory();
        frames[index] = frame;
        await this.writeManifest(frames);
        // After rename the new snapshot is authoritative, even if its final flush fails.
        published = false;
        await this.syncDirectory();
        return frame;
      } catch (error) {
        if (published) await unlink(imagePath).catch(() => undefined);
        throw error;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  /** Only serves revisions referenced by or older than the committed manifest. */
  async image(id: FrameId, revision: number): Promise<Buffer | undefined> {
    const frames = await this.list();
    if (revision > frames[id === 'left' ? 0 : 1].revision) return undefined;
    try {
      return await readFile(this.imagePath(id, revision));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
