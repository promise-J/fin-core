import { Router } from 'express';

import { Env } from '../../config/env.js';
import { Db } from '../../infrastructure/database/db.js';
import { argonPasswordHasher } from '../users/password.js';

import { buildAuthComposition } from './composition.js';
import { buildAuthController } from './controller.js';
import { requireAuth } from './middleware.js';

export interface AuthRouterDeps {
  db: Db;
  env: Env;
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
  });
  const auth = requireAuth({ env, db });

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  router.post('/logout-all', auth, controller.logoutAll);
  router.get('/me', auth, controller.me);

  return router;
}