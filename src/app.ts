import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import { createFramePictureRouter } from './routes/frame-pictures.js';

const app = express();

app.use(pinoHttp({ logger }));
// Express keeps proxy trust disabled; deployments must explicitly configure trusted proxies.
app.use(
  '/api/frame-pictures',
  cors({
    origin: process.env.FRONTEND_ORIGINS?.split(',').map((origin) => origin.trim()) ?? false,
    methods: ['GET', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    exposedHeaders: ['Retry-After'],
  }),
  createFramePictureRouter(),
);

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.json({
    message: 'Hello Express + TypeScript!',
  });
});

export default app;
