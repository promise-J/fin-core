# Financial Domain — Invariants, Money, and Accounting

## Money

- NGN minor unit is kobo. 1 NGN = 100 kobo.
- Internal representation: bigint.
- Storage: PostgreSQL BIGINT.
- API: decimal strings ("20000.00") in, decimal strings out. Never JSON number.
- Parsing is done by a single module (`src/common/money.ts`) with tests
  covering: leading zeros, sign rejection, more than 2 fractional digits, out-of-range,
  and empty input.

## Double-entry

- Chart of accounts: customer_wallet, platform_cash, payment_clearing,
  fee_revenue, refund_clearing, reversal_clearing.
- Postings are append-only. Corrections are compensating journals.
- Balancing is enforced by a DEFERRABLE INITIALLY DEFERRED constraint trigger on
  ledger_postings, checked at COMMIT of the journal's transaction.

## Invariants

(INV-1..INV-10 as listed in this first stage response. Each invariant is owned by a test file
that will be added in the stage that implements it. A CI job fails if a test that
asserts an invariant is deleted or skipped.)

## Explicit non-guarantees

- No claim of exactly-once across PostgreSQL ↔ RabbitMQ. Only: at-least-once delivery
  - consumer idempotency, which together give at-most-once _effects_.
- No real-money capability. See README.md.
