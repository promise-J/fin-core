import { Prisma } from '@prisma/client';

// import { Db } from '../../infrastructure/database/db';

/**
 * Compute a wallet's balance directly from postings.
 * This is the source of truth; Wallet.balance is the projection.
 * Used by the reconciliation job and by tests to catch drift.
 */
export async function computeWalletBalanceFromLedger(
    db: Prisma.TransactionClient | Prisma.TransactionClient,
    walletId: string,
): Promise<bigint> {
  const rows = await db.$queryRaw<Array<{ balance: bigint }>>`
    SELECT COALESCE(SUM(
      CASE p.direction
        WHEN 'CREDIT' THEN  p."amountMinor"
        WHEN 'DEBIT'  THEN -p."amountMinor"
      END
    ), 0)::bigint AS balance
    FROM "LedgerPosting" p
    JOIN "LedgerAccount" a ON a.id = p."ledgerAccountId"
    WHERE a."walletId" = ${walletId}
  `;
  return rows[0]?.balance ?? 0n;
}