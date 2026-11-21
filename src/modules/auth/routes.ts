import { Router } from 'express';

import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';
import { RateLimiter } from '../../infrastructure/redis/rate-limiter';
import { argonPasswordHasher } from '../users/password';

import { buildAuthComposition } from './composition';
import { buildAuthController } from './controller';
import { requireAuth } from './middleware';

export interface AuthRouterDeps {
  db: Db;
  env: Env;
  limiters?: {
    login: RateLimiter;
    register: RateLimiter;
    refresh: RateLimiter;
  };
}

export function buildAuthRouter({ db, env }: AuthRouterDeps) {
  const router = Router();
  const hasher = argonPasswordHasher;
  const composition = buildAuthComposition({ db, env, hasher });
  const controller = buildAuthController({
    db,
    env,
    users: composition.users,
    sessions: composition.sessions,
    hasher,
    verification: composition.verification,
  });
  const auth = requireAuth({ env, db });

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  router.post('/logout-all', auth, controller.logoutAll);
  router.get('/me', auth, controller.me);
  router.post('/verify-email', controller.verifyEmail);
  router.post('/resend-verification', controller.resendVerification);

  return router;
}