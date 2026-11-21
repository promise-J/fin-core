import { Request, Response, NextFunction } from 'express';

import { ProblemDetailsError } from '../../common/errors';
import { koboToNairaString } from '../../infrastructure/database/money';

import { CreateWalletBody, parseOrThrow } from './schemas';
import { WalletsService } from './service';

export function buildWalletsController(wallets: WalletsService) {
  return {
    async create(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        const input = parseOrThrow(CreateWalletBody, req.body ?? {});
        const wallet = await wallets.createForUser(req.user.id, input.currency);
        return res.status(201).json({ wallet: serializeWallet(wallet) });
      } catch (err) { 
        next(err);
        return
    }
    },

    async list(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        const rows = await wallets.listForUser(req.user.id);
        return res.json({ wallets: rows.map(serializeWallet) });
      } catch (err) {
         next(err);
         return
        }
    },

    async get(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        const wallet = await wallets.findOwned(req.params['walletId']!, req.user.id);
        return res.json({ wallet: serializeWallet(wallet) });
      } catch (err) {
         next(err); 
         return
        }
    },

    async balance(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        const b = await wallets.getBalance(req.params['walletId']!, req.user.id);
        return res.json({
          walletId: b.walletId,
          currency: b.currency,
          balanceMinor: b.balanceMinor.toString(),
          balance: koboToNairaString(b.balanceMinor),
        });
      } catch (err) { 
        next(err); 
        return
    }
    },
  };
}

function serializeWallet(w: {
  id: string; ownerId: string; currency: string; status: string;
  balance: bigint; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: w.id,
    ownerId: w.ownerId,
    currency: w.currency,
    status: w.status,
    balanceMinor: w.balance.toString(),
    balance: koboToNairaString(w.balance),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}