import { LedgerAccountType, Prisma } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';

export function buildLedgerAccountsService(db: Db) {
  return {
    /**
     * Every wallet needs exactly one CUSTOMER_WALLET ledger account.
     * Wallet creation and account creation must happen in the same
     * transaction so we never end up with a wallet that has no account
     * (which would break posting).
     */
    async createForWallet(
      tx: Prisma.TransactionClient,
      walletId: string,
      currency: string,
    ) {
      return tx.ledgerAccount.create({
        data: {
          type: 'CUSTOMER_WALLET',
          currency,
          walletId,
        },
      });
    },

    /**
     * Internal (platform) accounts: PLATFORM_CASH, PAYMENT_CLEARING,
     * FEE_REVENUE, etc. Seeded once, referenced by every financial flow.
     */
    async ensureInternal(
      tx: Prisma.TransactionClient,
      internalCode: string,
      type: LedgerAccountType,
      currency: string,
    ) {
      const existing = await tx.ledgerAccount.findUnique({
        where: { internalCode },
      });
      if (existing) {
        if (existing.type !== type || existing.currency !== currency) {
          throw new ProblemDetailsError(
            500,
            'internal_account_mismatch',
            `Internal account ${internalCode} exists with different type/currency.`,
          );
        }
        return existing;
      }
      return tx.ledgerAccount.create({
        data: { type, currency, internalCode },
      });
    },

    async findByInternalCode(code: string) {
      return db.ledgerAccount.findUnique({ where: { internalCode: code } });
    },

    async findByWalletId(walletId: string) {
      return db.ledgerAccount.findUnique({ where: { walletId } });
    },
  };
}

export type LedgerAccountsService = ReturnType<typeof buildLedgerAccountsService>;