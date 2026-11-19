import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { buildLogger } from './config/logger.js';

async function main() {
  const env = loadEnv();
  const logger = buildLogger({
    LOG_LEVEL: env.LOG_LEVEL,
    SERVICE_NAME: env.SERVICE_NAME,
    NODE_ENV: env.NODE_ENV,
  });

  const app = buildApp({ env, logger });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'fincore-api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown initiated');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'error while closing server');
        process.exit(1);
      }
      logger.info('shutdown complete');
      process.exit(0);
    });
    // Force-exit if graceful shutdown takes too long.
    setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Logger isn't ready yet — use console for startup errors.
  console.error('Fatal startup error:', err);
  process.exit(1);
});