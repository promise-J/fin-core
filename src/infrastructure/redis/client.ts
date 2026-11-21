
import Redis from 'ioredis';

import { Env } from '../../config/env';
import { AppLogger } from '../../config/logger';

export function buildRedis(env: Env, logger: AppLogger): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });
  client.on('error', (err) => logger.warn({ err }, 'redis error'));
  client.on('reconnecting', () => logger.warn('redis reconnecting'));
  client.on('ready', () => logger.info('redis ready'));
  return client;
}