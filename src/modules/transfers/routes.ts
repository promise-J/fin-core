import { Router } from 'express';

import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';
import { requireAuth } from '../auth/middleware';

import { buildTransferController } from './controller';
import { buildIdempotencyService } from './idempotency';

export interface TransfersRouterDeps { db: Db; env: Env; }

export function buildTransfersRouter({ db, env }: TransfersRouterDeps) {
  const router = Router();
  const idempotency = buildIdempotencyService(db);
  const controller = buildTransferController({ db, idempotency });
  const auth = requireAuth({ env, db });

  router.use(auth);
  router.post('/', controller.create);

  return router;
}