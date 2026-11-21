import { Router } from 'express';

import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';
import { requireAuth } from '../auth/middleware';
import { buildLedgerAccountsService } from '../ledger/accounts';

import { buildWalletsController } from './controller';
import { buildWalletsService } from './service';
import { buildStatementService } from './statement';

export interface WalletsRouterDeps { db: Db; env: Env; }

export function buildWalletsRouter({ db, env }: WalletsRouterDeps) {
  const router = Router();
  const ledgerAccounts = buildLedgerAccountsService(db);
  const service = buildWalletsService({ db, ledgerAccounts });
  const statementService = buildStatementService(db);
  const controller = buildWalletsController(service, statementService);
  const auth = requireAuth({ env, db });

  router.use(auth);
  router.post('/', controller.create);
  router.get('/', controller.list);
  router.get('/:walletId', controller.get);
  router.get('/:walletId/balance', controller.balance);
  router.get('/:walletId/statement', controller.statement);

  return router;
}