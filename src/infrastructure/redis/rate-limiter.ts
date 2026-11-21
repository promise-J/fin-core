import Redis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';

import { ProblemDetailsError } from '../../common/errors';
import { AppLogger } from '../../config/logger';

export interface RateLimiterConfig {
  points: number;
  durationSeconds: number;
  keyPrefix: string;
}

export interface RateLimiter {
  consume(key: string): Promise<void>;
}

export function buildRateLimiter(
  redis: Redis,
  logger: AppLogger,
  cfg: RateLimiterConfig,
  failOpen = true,
): RateLimiter {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: cfg.keyPrefix,
    points: cfg.points,
    duration: cfg.durationSeconds,
  });

  return {
    async consume(key) {
      try {
        await limiter.consume(key);
      } catch (err) {
        if (err instanceof Error) {
          if (failOpen) {
            logger.error({ err, keyPrefix: cfg.keyPrefix }, 'rate limiter unavailable, failing open');
            return;
          }
          throw new ProblemDetailsError(
            503,
            'rate_limiter_unavailable',
            'Rate limiting service is unavailable.',
          );
        }
        throw new ProblemDetailsError(
          429,
          'rate_limited',
          'Too many requests. Please slow down.',
        );
      }
    },
  };
}