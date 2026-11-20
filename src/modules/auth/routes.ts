import { Router } from 'express';

import { Env } from '../../config/env.js';
import { Db } from '../../infrastructure/database/db.js';

import { buildAuthController } from './controller.js';
import { requireAuth } from './middleware.js';

export interface AuthRouterDeps {
  db: Db;
  env: Env;
}

export function buildAuthRouter({ db, env }: AuthRouterDeps) {
  const router = Router();
  const controller = buildAuthController({ db });
  const auth = requireAuth({ env, db });

  router.get('/me', auth, controller.me);

  return router;
}