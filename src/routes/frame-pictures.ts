import { Router } from 'express';
import path from 'node:path';
import { createFramePictureController } from '../controllers/frame-pictures.js';
import {
  createUploadGuard,
  framePictureErrors,
  uploadImage,
  validateFrame,
} from '../middlewares/image-upload.js';
import { FramePictureStore } from '../services/frame-pictures.js';

/** Wires the shared picture API with one rate/concurrency guard per router. */
export function createFramePictureRouter(
  directory = process.env.FRAME_PICTURES_DIR ?? path.resolve('data/frame-pictures'),
): Router {
  const router = Router();
  const controller = createFramePictureController(new FramePictureStore(directory));
  router.get('/', controller.list);
  router.put('/:frameId', createUploadGuard(), validateFrame, uploadImage, controller.replace);
  router.get('/:frameId/images/:revision.jpg', validateFrame, controller.image);
  router.use(framePictureErrors);
  return router;
}
