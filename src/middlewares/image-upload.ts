import { Transform } from 'node:stream';
import type { RequestHandler, ErrorRequestHandler } from 'express';
import multer from 'multer';
import { FramePictureError, isFrameId } from '../services/frame-pictures.js';
import { logger } from '../utils/logger.js';

const createParser = (onType: (mime: string) => void) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(file.mimetype)) {
        callback(
          new FramePictureError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Use JPEG, PNG, WebP, or H.264 MP4.',
          ),
        );
        return;
      }
      onType(file.mimetype);
      callback(null, true);
    },
  }).single('image');

/** Validates frame IDs before any upload work or disk access occurs. */
export const validateFrame: RequestHandler = (req, _res, next) => {
  next(
    isFrameId(req.params.frameId)
      ? undefined
      : new FramePictureError(404, 'FRAME_NOT_FOUND', 'Frame not found.'),
  );
};

/** Bounds anonymous upload attempts and concurrent buffering/decoding together. */
export function createUploadGuard(): RequestHandler {
  const attempts = new Map<string, number[]>();
  let active = 0;
  return (req, res, next) => {
    const now = Date.now();
    for (const [ip, timestamps] of attempts) {
      const recent = timestamps.filter((time) => time > now - 60_000);
      if (recent.length) attempts.set(ip, recent);
      else attempts.delete(ip);
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const recent = attempts.get(ip) ?? [];
    if (recent.length >= 5) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000)));
      next(new FramePictureError(429, 'RATE_LIMITED', 'Try again shortly.'));
      return;
    }
    attempts.set(ip, [...recent, now]);
    if (active >= 2) {
      res.setHeader('Retry-After', '2');
      next(new FramePictureError(503, 'UPLOAD_BUSY', 'Upload processing is busy.'));
      return;
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.once('close', release);
    res.once('finish', release);
    next();
  };
}

/** Counts all multipart bytes before Multer, including chunked request overhead. */
export const uploadImage: RequestHandler = (req, res, next) => {
  let maximum = 51 * 1024 * 1024;
  const parser = createParser((mime) => {
    // Once the part headers identify an image, stop its stream at the original limit.
    if (!mime.startsWith('video/')) maximum = 11 * 1024 * 1024;
  });
  if (Number(req.headers['content-length']) > maximum) {
    next(
      new FramePictureError(
        413,
        'FILE_TOO_LARGE',
        'Choose an image up to 10 MiB or video up to 50 MiB.',
      ),
    );
    return;
  }
  if (!req.is('multipart/form-data')) {
    next(new FramePictureError(400, 'INVALID_UPLOAD', 'Send one multipart image field.'));
    return;
  }
  let bytes = 0;
  let done = false;
  const timer = setTimeout(
    () => finish(new FramePictureError(400, 'INVALID_UPLOAD', 'Upload timed out.')),
    30_000,
  );
  timer.unref();
  const finish = (error?: unknown) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req.unpipe(limited);
    limited.destroy();
    next(error);
  };
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maximum
          ? new FramePictureError(
              413,
              'FILE_TOO_LARGE',
              'Choose an image up to 10 MiB or video up to 50 MiB.',
            )
          : null,
        chunk,
      );
    },
  });
  // Multer reads the bounded stream while retaining Express request metadata.
  Object.assign(limited, { headers: req.headers, method: req.method });
  limited.once('error', finish);
  req.once('aborted', () =>
    finish(new FramePictureError(400, 'INVALID_UPLOAD', 'Upload interrupted.')),
  );
  req.once('error', finish);
  parser(limited as unknown as Parameters<RequestHandler>[0], res, (error: unknown) => {
    req.file = (limited as unknown as Parameters<RequestHandler>[0]).file;
    const file = req.file;
    // Keep the existing image limit within the larger shared video parser.
    if (
      !error &&
      file &&
      !file.mimetype.startsWith('video/') &&
      (file.size > 10 * 1024 * 1024 || bytes > 11 * 1024 * 1024)
    ) {
      finish(new FramePictureError(413, 'FILE_TOO_LARGE', 'Choose an image up to 10 MiB.'));
      return;
    }
    finish(
      error && !(error instanceof multer.MulterError) && !(error instanceof FramePictureError)
        ? new FramePictureError(400, 'INVALID_UPLOAD', 'Malformed multipart upload.')
        : error,
    );
  });
  req.pipe(limited);
};

/** Keeps all frame API failures in the documented JSON envelope. */
export const framePictureErrors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  let failure = error;
  if (error instanceof multer.MulterError) {
    failure = new FramePictureError(
      error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD',
      'Send one image up to 10 MiB or video up to 50 MiB.',
    );
  }
  if (!(failure instanceof FramePictureError)) {
    logger.error({ err: error }, 'Frame picture operation failed');
    failure = new FramePictureError(503, 'STORAGE_UNAVAILABLE', 'Picture storage is unavailable.');
  }
  const publicError = failure as FramePictureError;
  logger.warn({ code: publicError.code }, 'Frame picture request rejected');
  if (res.headersSent) return;
  res.setHeader('Cache-Control', 'no-store');
  res
    .status(publicError.status)
    .json({ error: { code: publicError.code, message: publicError.message } });
};
