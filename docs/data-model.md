# Data Model

## Money

All monetary values are stored as `BIGINT` in kobo (1 NGN = 100 kobo).
API responses serialize kobo as decimal strings ("20000.00").

## Ledger

`LedgerPosting` is the source of truth for money movement.
`Wallet.balance` is a materialized projection maintained in the same
transaction as its postings. A deferred constraint trigger
(`wallet_balance_matches_ledger`) aborts the transaction at COMMIT if
the projection ever drifts from the ledger.

Postings are immutable. The database refuses UPDATE and DELETE via
triggers. Corrections are made by inserting a new compensating
`JournalEntry` that references the original.

## Deletion policy

Financial records use `onDelete: Restrict`. Deleting a User who has
wallets, transfers, or ledger history is refused by Postgres.

## Idempotency

`IdempotencyRecord` is unique on `(scope, key)`. The database, not Redis,
is the deduplication authority. Same key + different request fingerprint
is rejected in the service layer under a row lock.