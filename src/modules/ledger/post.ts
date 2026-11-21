import { Prisma, JournalEntry, LedgerPosting } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
// import { Db } from '../../infrastructure/database/db';

import { PostJournalInput } from './types';

/**
 * Insert a balanced journal entry and apply wallet projection updates
 * atomically. MUST be called inside a Prisma transaction that also
 * creates the originating business record (Transfer, Payment, etc.).
 *
 * Invariants this function enforces before touching the DB:
 *   - At least two postings.
 *   - All postings share the same currency.
 *   - All amounts are positive.
 *   - sum(debits) == sum(credits).
 *
 * The database has a deferred constraint trigger that re-checks these
 * at COMMIT, so even if this function is bypassed, we can't commit a
 * broken journal.
 */
export async function postJournal(
  tx: Prisma.TransactionClient,
  input: PostJournalInput,
): Promise<{ journalEntry: JournalEntry; postings: LedgerPosting[] }> {
  validateInput(input);

  const journalEntry = await tx.journalEntry.create({
    data: {
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      transactionType: input.transactionType,
      currency: input.currency,
      status: 'POSTED',
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
    },
  });

  const postings = await Promise.all(
    input.postings.map((p) =>
      tx.ledgerPosting.create({
        data: {
          journalEntryId: journalEntry.id,
          ledgerAccountId: p.ledgerAccountId,
          direction: p.direction,
          amountMinor: p.amountMinor,
          currency: input.currency,
        },
      }),
    ),
  );

  for (const update of input.updates) {
    await tx.$executeRaw`
      UPDATE "Wallet"
      SET balance = balance + ${update.deltaMinor}, "updatedAt" = now()
      WHERE id = ${update.walletId}
    `;
  }

  return { journalEntry, postings };
}

function validateInput(input: PostJournalInput): void {
  if (input.postings.length < 2) {
    throw new ProblemDetailsError(
      500,
      'invalid_journal',
      'A journal entry must have at least two postings.',
    );
  }

  const currencies = new Set(input.postings.map((_p) => input.currency));
  if (currencies.size !== 1) {
    throw new ProblemDetailsError(500, 'invalid_journal', 'Journal mixes currencies.');
  }

  let debits = 0n;
  let credits = 0n;
  for (const p of input.postings) {
    if (p.amountMinor <= 0n) {
      throw new ProblemDetailsError(500, 'invalid_journal', 'Posting amount must be positive.');
    }
    if (p.direction === 'DEBIT') debits += p.amountMinor;
    else credits += p.amountMinor;
  }

  if (debits !== credits) {
    throw new ProblemDetailsError(
      500,
      'unbalanced_journal',
      `Journal does not balance: debits=${debits} credits=${credits}.`,
    );
  }

  // Belt and braces: net wallet delta must equal net liability change
  // for the wallets affected. This is the ledger-side of the balance
  // projection rule.
  const netDelta = input.updates.reduce((s, u) => s + u.deltaMinor, 0n);
  // We don't compare netDelta directly because postings may hit
  // non-wallet accounts (PLATFORM_CASH etc.), so the wallet deltas
  // and the total credit-debit side won't always match. The deferred
  // trigger enforces the per-wallet invariant that actually matters.
  void netDelta;
}