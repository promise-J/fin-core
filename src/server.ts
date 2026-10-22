import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { buildLogger } from './config/logger.js';

const env = loadEnv();
const logger = buildLogger(env);
const app = createApp({ env, logger });
const server = createServer(app);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'fincore_api_listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    // eslint-disable-next-line no-console
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown_initiated');

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'http_close_error');
      process.exit(1);
    }
    logger.info('shutdown_complete');
    process.exit(0);
  });

  if ('closeAllConnections' in server) {
    server.closeAllConnections();
  }

  setTimeout(() => {
    logger.error('shutdown_timeout_forcing_exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled_rejection');
  process.exit(1);
});