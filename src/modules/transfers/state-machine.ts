import { TransferStatus } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';

/**
 * Legal transfers between statuses. Any pair not listed here is illegal.
 * This is the single source of truth — every status change goes through
 * `assertTransition` before writing.
 */
const LEGAL_TRANSITIONS: Record<TransferStatus, ReadonlyArray<TransferStatus>> = {
  PENDING: ['PROCESSING', 'CANCELLED', 'FAILED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['REVERSED'],
  FAILED: [],
  CANCELLED: [],
  REVERSED: [],
};

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TransferStatus, to: TransferStatus): void {
  if (!canTransition(from, to)) {
    throw new ProblemDetailsError(
      409,
      'invalid_transition',
      `Transfer status cannot change from ${from} to ${to}.`,
      { from, to },
    );
  }
}