import 'dotenv/config';
import app from './app.js';
import { createServer } from 'node:http';
import { initializeWebSocket } from './websocket.js';
import { logger } from './utils/logger.js';

const PORT = Number(process.env.PORT) || 3000;

// HTTP and real-time connections share one port so clients use the same deployment endpoint.
const server = createServer(app);
const wss = initializeWebSocket(server);

server.on('error', (err) => {
  logger.fatal({ err }, 'HTTP server failed');
  process.exit(1);
});
server.listen(PORT, () => {
  logger.info({ port: PORT, websocketPath: '/' }, 'Server started');
});

// Stop upgraded sockets explicitly because HTTP shutdown does not close them.
function shutdown(): void {
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
