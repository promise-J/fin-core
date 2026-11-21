import { Request, Response, NextFunction } from 'express';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';
import { nairaToKobo } from '../../infrastructure/database/money';

import { IdempotencyService, fingerprint } from './idempotency';
import { CreateTransferBody, parseOrThrow, requireIdempotencyKey } from './schemas';

export interface TransferControllerDeps {
  db: Db;
  idempotency: IdempotencyService;
}

export function buildTransferController(deps: TransferControllerDeps) {
  const { idempotency } = deps;

  return {
    async create(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) {
          throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        }
        const key = requireIdempotencyKey(req);
        const input = parseOrThrow(CreateTransferBody, req.body);
        const fp = fingerprint(req.body as Record<string, unknown>);

        const result = await idempotency.run(
          {
            scope: 'transfer:create',
            key,
            userId: req.user.id,
            requestFingerprint: fp,
          },
          async () => {
            // 4.3 fills this in. For now the operation is a stub
            // that returns not_implemented — but the idempotency
            // layer runs before that, which means the "same key
            // twice" test can verify the replay behavior even
            // without a working transfer.
            void input; // silence unused
            void nairaToKobo; // silence unused
            throw new ProblemDetailsError(
              500,
              'not_implemented',
              'Transfer transaction is wired in 4.3.',
            );
          },
        );

        return res.status(result.status).json(result.body);
      } catch (err) {
        next(err);
        return
      }
    },
  };
}