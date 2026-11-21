import { randomUUID } from 'node:crypto';

import { Request, Response, NextFunction } from 'express';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';
import { nairaToKobo, koboToNairaString } from '../../infrastructure/database/money';

import { buildTransferExecutor } from './executor';
import { IdempotencyService, fingerprint } from './idempotency';
import { CreateTransferBody, parseOrThrow, requireIdempotencyKey } from './schemas';
import { buildTransferService } from './service';

export interface TransferControllerDeps {
  db: Db;
  idempotency: IdempotencyService;
}

export function buildTransferController(deps: TransferControllerDeps) {
  const { db, idempotency } = deps;
  const executor = buildTransferExecutor(db);

  return {
    async create(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) {
          throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        }
        const key = requireIdempotencyKey(req);
        const input = parseOrThrow(CreateTransferBody, req.body);
        const fp = fingerprint(req.body as Record<string, unknown>);
        const correlationId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

        const result = await idempotency.run(
          {
            scope: 'transfer:create',
            key,
            userId: req.user.id,
            requestFingerprint: fp,
          },
          async (tx) => {
            const amountMinor = nairaToKobo(input.amount);
            const { transfer, journalEntryId } = await executor.executeInTransaction(tx, {
              initiatorId: req.user!.id,
              sourceWalletId: input.sourceWalletId,
              destinationWalletId: input.destinationWalletId,
              amountMinor,
              feeMinor: 0n,
              currency: input.currency,
              correlationId,
            });
            return {
              status: 201,
              resourceId: transfer.id,
              body: {
                transfer: {
                  id: transfer.id,
                  status: transfer.status,
                  sourceWalletId: transfer.sourceWalletId,
                  destinationWalletId: transfer.destinationWalletId,
                  amountMinor: transfer.amountMinor.toString(),
                  amount: koboToNairaString(transfer.amountMinor),
                  feeMinor: transfer.feeMinor.toString(),
                  currency: transfer.currency,
                  journalEntryId,
                  createdAt: transfer.createdAt.toISOString(),
                  completedAt: transfer.completedAt?.toISOString() ?? null,
                },
              },
            };
          },
        );

        return res.status(result.status).json(result.body);
      } catch (err) {
        next(err);
        return
      }
    },
    async cancel(req: Request, res: Response, next: NextFunction) {
        try {
          if (!req.user) throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
          const transferId = req.params['transferId']!;
          const result = await db.$transaction(async (tx) => {
            const existing = await tx.transfer.findUnique({ where: { id: transferId } });
            if (!existing) throw new ProblemDetailsError(404, 'transfer_not_found', 'Transfer not found.');
            if (existing.initiatorId !== req.user!.id) {
              throw new ProblemDetailsError(404, 'transfer_not_found', 'Transfer not found.');
            }
            const svc = buildTransferService({ db });
            return svc.cancel(tx, transferId);
          });
          return res.json({ transfer: { id: result.id, status: result.status } });
        } catch (err) { next(err); }
      }
  };
}