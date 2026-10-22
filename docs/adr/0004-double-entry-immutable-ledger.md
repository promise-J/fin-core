# ADR-0004: Double-entry, immutable, append-only ledger

## Context
Wallet balances must be derivable and auditable. Editing rows to "fix" balances hides
fraud and breaks reconciliation.

## Decision
Every financial operation produces a journal entry with >= 2 postings whose debits and
credits balance per currency. Postings are insert-only (enforced by a trigger). Reversals
and refunds are compensating journals.

## Consequences
- Balance = fold over postings (with a maintained projection for read performance, not
  for authority).
- Any "correction" is a new journal — visible, auditable, and reconcilable.

## Revisit when
- Never. This is the load-bearing decision of the project.