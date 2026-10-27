import { validateVideo } from '../services/video.js';
import type { RequestHandler } from 'express';
import {
  FramePictureError,
  FramePictureStore,
  isFrameId,
  normalizeImage,
} from '../services/frame-pictures.js';

/** Creates HTTP handlers while keeping decoding and persistence outside controllers. */
export function createFramePictureController(store: FramePictureStore): {
  list: RequestHandler;
  replace: RequestHandler;
  image: RequestHandler;
} {
  return {
    list: async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ frames: await store.list() });
    },
    replace: async (req, res) => {
      if (!isFrameId(req.params.frameId) || !req.file?.buffer.length) {
        throw new FramePictureError(400, 'INVALID_UPLOAD', 'Send one nonempty image field.');
      }
      const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
      const media =
        mediaType === 'video'
          ? validateVideo(req.file.buffer)
          : await normalizeImage(req.file.buffer);
      // A client that disconnects during decoding must not commit an unseen replacement.
      if (req.aborted || res.destroyed) return;
      const frame = await store.replace(req.params.frameId, media, mediaType);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ frame });
    },
    image: async (req, res) => {
      const parameter = req.params.revision;
      const revision = Number(parameter);
      if (
        !isFrameId(req.params.frameId) ||
        typeof parameter !== 'string' ||
        !/^[1-9]\d*$/.test(parameter) ||
        !Number.isSafeInteger(revision)
      ) {
        throw new FramePictureError(404, 'IMAGE_NOT_FOUND', 'Image not found.');
      }
      const video = req.path.includes('/videos/');
      const jpeg = await store.image(req.params.frameId, revision, video ? 'video' : 'image');
      if (!jpeg) throw new FramePictureError(404, 'IMAGE_NOT_FOUND', 'Image not found.');
      res.set({
        'Content-Type': video ? 'video/mp4' : 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      if (video) {
        res.setHeader('Accept-Ranges', 'bytes');
        // A single byte range supports browser seeking without exposing filesystem paths.
        const range = req.headers.range;
        if (
          range &&
          (!req.headers['if-range'] || req.headers['if-range'] === res.getHeader('ETag'))
        ) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match?.[1]
            ? Number(match[1])
            : Math.max(0, jpeg.length - Number(match?.[2]));
          const end =
            match?.[1] && match[2] ? Math.min(Number(match[2]), jpeg.length - 1) : jpeg.length - 1;
          if (
            !match ||
            (!match[1] && !match[2]) ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= jpeg.length
          ) {
            res.setHeader('Content-Range', 'bytes */' + jpeg.length);
            res.status(416).end();
            return;
          }
          res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + jpeg.length);
          res.status(206).send(jpeg.subarray(start, end + 1));
          return;
        }
      }
      res.send(jpeg);
    },
  };
}
