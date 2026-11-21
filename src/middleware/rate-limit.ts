import { Request, Response, NextFunction } from 'express';

import { RateLimiter } from '../../src/infrastructure/redis/rate-limiter';


export function rateLimit(
  limiter: RateLimiter,
  keyFn: (req: Request) => string = (req) => req.ip ?? 'unknown',
) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await limiter.consume(keyFn(req));
      next();
    } catch (err) {
      next(err);
    }
  };
}