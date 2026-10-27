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
      const jpeg = await normalizeImage(req.file.buffer);
      // A client that disconnects during decoding must not commit an unseen replacement.
      if (req.aborted || res.destroyed) return;
      const frame = await store.replace(req.params.frameId, jpeg);
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
      const jpeg = await store.image(req.params.frameId, revision);
      if (!jpeg) throw new FramePictureError(404, 'IMAGE_NOT_FOUND', 'Image not found.');
      res.set({
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.send(jpeg);
    },
  };
}
