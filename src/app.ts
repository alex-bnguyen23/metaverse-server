import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./utils/logger.js";

const app = express();

app.use(pinoHttp({ logger }));
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Hello Express + TypeScript!",
  });
});

export default app;