# Financial Domain

## Chart of accounts

- CUSTOMER_WALLET — liabilities owed to customers (credit-normal).
- PLATFORM_CASH — asset account holding cash.
- PAYMENT_CLEARING — interim account during provider settlement.
- FEE_REVENUE — income from transaction fees.
- REFUND_CLEARING — interim account during refunds.
- REVERSAL_CLEARING — interim account during reversals.
- SUSPENSE — account for unknown / mismatched funds pending reconciliation.

## Internal transfer

Debit customer A's wallet (decrease liability, i.e. their balance).
Credit customer B's wallet (increase liability).
No platform account is involved: money moves between two customers,
and total platform liabilities are unchanged.

## Wallet funding (via simulated provider)

Provider reports success. We post:

  Debit  PAYMENT_CLEARING   (asset increases — we now hold the cash)
  Credit CUSTOMER_WALLET    (liability to customer increases)

## Fee

When a fee applies:

  Debit  CUSTOMER_WALLET
  Credit FEE_REVENUE

## Reversal

Reversals never edit the original journal. They insert a new
JournalEntry with `reversesEntryId` set and mirrored postings.
The original entry's status flips to REVERSED — that's the only
field a JournalEntry is allowed to change.

## Invariants (enforced at the database level)

- Every JournalEntry has SUM(debits) = SUM(credits), same currency.
- LedgerPosting rows are immutable.
- Wallet.balance equals the sum of its ledger account's postings.
- All amounts are positive integers (the direction determines sign).
