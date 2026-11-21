import { Prisma, Transfer } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';
import { buildLedgerAccountsService } from '../ledger/accounts';
import { postJournal } from '../ledger/post';

import { buildTransferService } from './service';

export interface ExecuteTransferInput {
  initiatorId: string;
  sourceWalletId: string;
  destinationWalletId: string;
  amountMinor: bigint;
  feeMinor: bigint;
  currency: string;
  correlationId: string;
}

export function buildTransferExecutor(db: Db) {
  const transfers = buildTransferService({ db });
  const ledgerAccounts = buildLedgerAccountsService(db);

  return {
    /**
     * Execute the full transfer inside the caller's transaction.
     * The caller (idempotency.run) has already wrapped this in a
     * transaction; we must NOT open a nested one.
     */
    async executeInTransaction(
      tx: Prisma.TransactionClient,
      input: ExecuteTransferInput,
    ): Promise<{ transfer: Transfer; journalEntryId: string }> {
      if (input.amountMinor <= 0n) {
        throw new ProblemDetailsError(400, 'invalid_amount', 'Amount must be positive.');
      }
      if (input.feeMinor < 0n) {
        throw new ProblemDetailsError(400, 'invalid_fee', 'Fee cannot be negative.');
      }
      if (input.sourceWalletId === input.destinationWalletId) {
        throw new ProblemDetailsError(400, 'same_wallet', 'Source and destination must be different.');
      }

      // ---- Step 1: lock both wallets in a stable order ----
      // Stable order = ORDER BY id. If two transfers involve the same
      // pair of wallets in opposite directions, both acquire the same
      // lock order and cannot deadlock.
      const wallets = await tx.$queryRaw<Array<{
        id: string;
        ownerId: string;
        balance: bigint;
        status: string;
        currency: string;
      }>>`
        SELECT id, "ownerId", balance, status::text AS status, currency
        FROM "Wallet"
        WHERE id IN (${input.sourceWalletId}, ${input.destinationWalletId})
        ORDER BY id
        FOR UPDATE
      `;

      if (wallets.length !== 2) {
        throw new ProblemDetailsError(404, 'wallet_not_found', 'One or both wallets do not exist.');
      }

      const source = wallets.find((w) => w.id === input.sourceWalletId)!;
      const destination = wallets.find((w) => w.id === input.destinationWalletId)!;

      // ---- Step 2: validate ownership / status / currency ----
      if (source.ownerId !== input.initiatorId) {
        // Do not leak that the wallet exists — 404 like "not found".
        throw new ProblemDetailsError(404, 'wallet_not_found', 'Source wallet not found.');
      }
      if (source.status !== 'ACTIVE' || destination.status !== 'ACTIVE') {
        throw new ProblemDetailsError(409, 'wallet_inactive', 'One or both wallets are not active.');
      }
      if (source.currency !== input.currency || destination.currency !== input.currency) {
        throw new ProblemDetailsError(
          409,
          'currency_mismatch',
          'Source, destination, and transfer currency must match.',
        );
      }

      // ---- Step 3: check funds ----
      const required = input.amountMinor + input.feeMinor;
      if (source.balance < required) {
        throw new ProblemDetailsError(
          400,
          'insufficient_funds',
          'Source wallet has insufficient funds.',
          { required: required.toString(), available: source.balance.toString() },
        );
      }

      // ---- Step 4: create the transfer row (PROCESSING) ----
      const transfer = await transfers.createPending(tx, {
        initiatorId: input.initiatorId,
        sourceWalletId: input.sourceWalletId,
        destinationWalletId: input.destinationWalletId,
        amountMinor: input.amountMinor,
        feeMinor: input.feeMinor,
        currency: input.currency,
        correlationId: input.correlationId,
      });
      await transfers.markProcessing(tx, transfer.id);

      // ---- Step 5: resolve ledger accounts ----
      const [srcAcct, dstAcct, feeAcct] = await Promise.all([
        ledgerAccounts.findByWalletId(input.sourceWalletId),
        ledgerAccounts.findByWalletId(input.destinationWalletId),
        input.feeMinor > 0n
          ? ledgerAccounts.findByInternalCode(`FEE_REVENUE_${input.currency}`)
          : Promise.resolve(null),
      ]);
      if (!srcAcct || !dstAcct) {
        throw new ProblemDetailsError(
          500,
          'ledger_account_missing',
          'Wallet ledger accounts are missing. This is a data integrity error.',
        );
      }
      if (input.feeMinor > 0n && !feeAcct) {
        throw new ProblemDetailsError(
          500,
          'fee_account_missing',
          'Fee revenue ledger account is missing. Run the seed.',
        );
      }

      // ---- Step 6: build the posting list ----
      const postings = [
        {
          ledgerAccountId: srcAcct.id,
          direction: 'DEBIT' as const,
          amountMinor: required, // amount + fee
        },
        {
          ledgerAccountId: dstAcct.id,
          direction: 'CREDIT' as const,
          amountMinor: input.amountMinor,
        },
        ...(input.feeMinor > 0n
          ? [{
              ledgerAccountId: feeAcct!.id,
              direction: 'CREDIT' as const,
              amountMinor: input.feeMinor,
            }]
          : []),
      ];

      // ---- Step 7: post the journal ----
      const { journalEntry } = await postJournal(tx, {
        referenceType: 'TRANSFER',
        referenceId: transfer.id,
        transactionType: 'INTERNAL_TRANSFER',
        currency: input.currency,
        postings,
        updates: [
          { walletId: input.sourceWalletId, deltaMinor: -required },
          { walletId: input.destinationWalletId, deltaMinor: input.amountMinor },
        ],
        createdByUserId: input.initiatorId,
      });

      // ---- Step 8: mark COMPLETED ----
      const completed = await transfers.markCompleted(tx, transfer.id, journalEntry.id);

      // ---- Step 9: outbox event (in the same transaction) ----
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'Transfer',
          aggregateId: transfer.id,
          eventType: 'transfer.completed.v1',
          eventVersion: 1,
          payload: {
            transferId: transfer.id,
            sourceWalletId: input.sourceWalletId,
            destinationWalletId: input.destinationWalletId,
            amountMinor: input.amountMinor.toString(),
            feeMinor: input.feeMinor.toString(),
            currency: input.currency,
            journalEntryId: journalEntry.id,
            completedAt: new Date().toISOString(),
          },
          correlationId: input.correlationId,
        },
      });

      return { transfer: completed, journalEntryId: journalEntry.id };
    },
  };
}

export type TransferExecutor = ReturnType<typeof buildTransferExecutor>;