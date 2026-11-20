import 'dotenv/config'
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { buildLogger } from './config/logger.js';
import { buildPrisma } from './infrastructure/database/db.js';

async function main() {
  const env = loadEnv();
  const db = buildPrisma(env);
  
  const logger = buildLogger({
    LOG_LEVEL: env.LOG_LEVEL,
    SERVICE_NAME: env.SERVICE_NAME,
    NODE_ENV: env.NODE_ENV,
    REDIS_URL: env.REDIS_URL,
    DATABASE_URL: env.DATABASE_URL,
    JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET,
  });

  const app = buildApp({ env, logger, db });

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
  console.error('Fatal startup error:', err);
  process.exit(1);
});