import { Prisma } from '@prisma/client';

import { Db } from '../../infrastructure/database/db';

export interface StatementRow {
  postingId: string;
  journalEntryId: string;
  postedAt: Date;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
  currency: string;
  // Business reference — what caused this posting.
  referenceType: string;
  referenceId: string;
  transactionType: string;
  // Running balance after this posting, computed in the query.
  runningBalanceMinor: bigint;
}

export interface StatementPage {
  rows: StatementRow[];
  nextCursor: string | null; // postingId of the next page, or null
}

export function buildStatementService(db: Db) {
  return {
    async page(
      walletId: string,
      opts: { limit: number; cursor?: string },
    ): Promise<StatementPage> {
      const limit = Math.min(Math.max(opts.limit, 1), 100);

      // Cursor is the last posting id from the previous page; we filter
      // rows strictly older than it (by createdAt, then id as tiebreak).
      const rows = await db.$queryRaw<StatementRow[]>`
        WITH ordered AS (
          SELECT
            p.id              AS "postingId",
            p."journalEntryId" AS "journalEntryId",
            p."createdAt"     AS "postedAt",
            p.direction::text AS "direction",
            p."amountMinor"   AS "amountMinor",
            p.currency        AS "currency",
            je."referenceType" AS "referenceType",
            je."referenceId"   AS "referenceId",
            je."transactionType" AS "transactionType",
            SUM(
              CASE p.direction
                WHEN 'CREDIT' THEN  p."amountMinor"
                WHEN 'DEBIT'  THEN -p."amountMinor"
              END
            ) OVER (ORDER BY p."createdAt", p.id) AS "runningBalanceMinor"
          FROM "LedgerPosting" p
          JOIN "LedgerAccount" a ON a.id = p."ledgerAccountId"
          JOIN "JournalEntry" je ON je.id = p."journalEntryId"
          WHERE a."walletId" = ${walletId}
          ${
            opts.cursor
              ? Prisma.sql`AND (p."createdAt", p.id) > (SELECT "createdAt", id FROM "LedgerPosting" WHERE id = ${opts.cursor})`
              : Prisma.empty
          }
        )
        SELECT * FROM ordered
        ORDER BY "postedAt", "postingId"
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        rows: page,
        nextCursor: hasMore ? page[page.length - 1]!.postingId : null,
      };
    },
  };
}

export type StatementService = ReturnType<typeof buildStatementService>;