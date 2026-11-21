import { Prisma, Transfer } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';

import { assertTransition } from './state-machine';

export interface TransferServiceDeps {
  db: Db;
}

/**
 * The service below is deliberately partial in 4.1:
 *   - createPending() creates the row but does NOT move money yet.
 *   - markCompleted() throws not_implemented until 4.3 wires postJournal.
 *   - cancel() only permits CANCELLED in PENDING.
 *
 * In 4.2 these methods get idempotency keys; in 4.3 they get
 * the actual transfer transaction (locks + journal + outbox).
 */
export function buildTransferService({ db: _ }: TransferServiceDeps) {
  return {
    /**
     * Create a transfer in PENDING state. Does NOT lock wallets or post
     * a journal. That's the "create the transfer intent" step; the
     * actual money movement is a separate operation.
     *
     * Caller must be inside a transaction if they also need to write
     * the idempotency record atomically with this row.
     */
    async createPending(
      tx: Prisma.TransactionClient,
      input: {
        initiatorId: string;
        sourceWalletId: string;
        destinationWalletId: string;
        amountMinor: bigint;
        feeMinor: bigint;
        currency: string;
        correlationId: string;
      },
    ): Promise<Transfer> {
      if (input.amountMinor <= 0n) {
        throw new ProblemDetailsError(400, 'invalid_amount', 'Amount must be positive.');
      }
      if (input.feeMinor < 0n) {
        throw new ProblemDetailsError(400, 'invalid_fee', 'Fee cannot be negative.');
      }
      if (input.sourceWalletId === input.destinationWalletId) {
        throw new ProblemDetailsError(
          400,
          'same_wallet',
          'Source and destination must be different wallets.',
        );
      }

      return tx.transfer.create({
        data: {
          initiatorId: input.initiatorId,
          sourceWalletId: input.sourceWalletId,
          destinationWalletId: input.destinationWalletId,
          amountMinor: input.amountMinor,
          feeMinor: input.feeMinor,
          currency: input.currency,
          status: 'PENDING',
          correlationId: input.correlationId,
        },
      });
    },

    /**
     * Move PENDING → PROCESSING and record that processing started.
     * Legal only from PENDING. A second call from PROCESSING would be
     * a retry, but retries should resume the transfer, not re-mark it.
     */
    async markProcessing(tx: Prisma.TransactionClient, transferId: string): Promise<Transfer> {
      const existing = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!existing) {
        throw new ProblemDetailsError(404, 'transfer_not_found', 'Transfer not found.');
      }
      assertTransition(existing.status, 'PROCESSING');
      return tx.transfer.update({
        where: { id: transferId },
        data: { status: 'PROCESSING' },
      });
    },

    /**
     * Mark COMPLETED. In 4.1 this throws — the real version arrives in
     * 4.3 and must be called only after postJournal succeeded.
     */
    async markCompleted(
        tx: Prisma.TransactionClient,
        transferId: string,
        journalEntryId: string,
      ): Promise<Transfer> {
        const existing = await tx.transfer.findUnique({ where: { id: transferId } });
        if (!existing) {
          throw new ProblemDetailsError(404, 'transfer_not_found', 'Transfer not found.');
        }
        assertTransition(existing.status, 'COMPLETED');
        return tx.transfer.update({
          where: { id: transferId },
          data: {
            status: 'COMPLETED',
            journalEntryId,
            completedAt: new Date(),
          },
        });
      },

    /**
     * Mark FAILED with a code and message.
     * Legal only from PENDING or PROCESSING.
     */
    async markFailed(
      tx: Prisma.TransactionClient,
      transferId: string,
      failureCode: string,
      failureMessage: string,
    ): Promise<Transfer> {
      const existing = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!existing) {
        throw new ProblemDetailsError(404, 'transfer_not_found', 'Transfer not found.');
      }
      assertTransition(existing.status, 'FAILED');
      return tx.transfer.update({
        where: { id: transferId },
        data: { status: 'FAILED', failureCode, failureMessage },
      });
    },

    /**
     * Cancel a transfer. Legal only from PENDING — once PROCESSING,
     * funds are being committed and the only correction is a reversal.
     */
    async cancel(tx: Prisma.TransactionClient, transferId: string): Promise<Transfer> {
      const existing = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!existing) {
        throw new ProblemDetailsError(404, 'transfer_not_found', 'Transfer not found.');
      }
      assertTransition(existing.status, 'CANCELLED');
      return tx.transfer.update({
        where: { id: transferId },
        data: { status: 'CANCELLED' },
      });
    },
  };
}

export type TransferService = ReturnType<typeof buildTransferService>;