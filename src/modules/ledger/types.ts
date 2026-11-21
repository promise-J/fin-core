import { PostingDirection } from '@prisma/client';

export interface PostingInput {
  ledgerAccountId: string;
  direction: PostingDirection;
  amountMinor: bigint;
}

export interface WalletProjectionUpdate {
  walletId: string;
  deltaMinor: bigint;
}

export interface PostJournalInput {
  referenceType: 'TRANSFER' | 'PAYMENT' | 'REFUND' | 'REVERSAL' | 'CORRECTION' | 'FUNDING';
  referenceId: string;
  transactionType: string;
  currency: string;
  postings: PostingInput[];
  updates: WalletProjectionUpdate[];
  createdByUserId?: string;
}