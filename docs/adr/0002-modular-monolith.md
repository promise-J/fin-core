# ADR-0002: Modular monolith before any service split

## Context

Financial systems need single-transaction atomicity across wallet debit, ledger
postings, balance projection, outbox, and idempotency. Splitting services before the
ledger is proven is premature and introduces distributed-transaction complexity.

## Decision

One codebase, one container image, three entrypoints (api, outbox, notifier) plus a
scheduled reconciler. Module boundaries in `src/modules/*` are enforced by ESLint
`no-restricted-imports` rules.

## Consequences

- Pros: real ACID transactions for the money path.
- Cons: deploy is all-or-nothing per image. Acceptable at this stage.
- Scaling is per-entrypoint replica count, not per-service.

## Revisit when

- A specific module's write load forces independent scaling AND the transactions it
  participates in can be made non-atomic (rare in a ledger).
