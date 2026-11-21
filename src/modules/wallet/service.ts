import { Prisma } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';
import { LedgerAccountsService } from '../ledger/accounts';

export interface WalletsServiceDeps {
  db: Db;
  ledgerAccounts: LedgerAccountsService;
}

export function buildWalletsService({ db, ledgerAccounts }: WalletsServiceDeps) {
  return {
    /**
     * Create a wallet for the user. The `Wallet` row and its
     * `CUSTOMER_WALLET` `LedgerAccount` are created in one transaction:
     * we never produce a wallet that can't accept postings.
     */
    async createForUser(userId: string, currency: string) {
      try {
        return await db.$transaction(async (tx) => {
          const wallet = await tx.wallet.create({
            data: { ownerId: userId, currency, balance: 0n, status: 'ACTIVE' },
          });
          await ledgerAccounts.createForWallet(tx, wallet.id, currency);
          return wallet;
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ProblemDetailsError(
            409,
            'wallet_exists',
            `A ${currency} wallet already exists for this user.`,
          );
        }
        throw err;
      }
    },

    async listForUser(userId: string) {
      return db.wallet.findMany({
        where: { ownerId: userId },
        orderBy: { createdAt: 'asc' },
      });
    },

    /**
     * Fetch a wallet the user owns. If it exists but belongs to
     * another user, we return the same 404 as if it didn't exist —
     * this prevents walking the ID space.
     */
    async findOwned(walletId: string, userId: string) {
      const wallet = await db.wallet.findFirst({
        where: { id: walletId, ownerId: userId },
      });
      if (!wallet) {
        throw new ProblemDetailsError(404, 'wallet_not_found', 'Wallet not found.');
      }
      return wallet;
    },

    async getBalance(walletId: string, userId: string) {
      const wallet = await this.findOwned(walletId, userId);
      return { walletId: wallet.id, currency: wallet.currency, balanceMinor: wallet.balance };
    },
  };
}

export type WalletsService = ReturnType<typeof buildWalletsService>;