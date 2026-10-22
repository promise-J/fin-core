# ADR-0003: PostgreSQL is the sole system of record for money

## Context
Financial correctness requires a durable, transactional store with strong consistency
and mature concurrency primitives (row locks, SERIALIZABLE, deferrable constraints).

## Decision
PostgreSQL via Prisma for typed access, with hand-written SQL where Prisma's
transaction/locking behavior is insufficient (e.g., SELECT ... FOR UPDATE SKIP LOCKED
on the outbox, deferred balancing trigger).

## Consequences
- Redis and RabbitMQ are explicitly non-authoritative for money.
- Backups, PITR, and migration discipline are first-class operational concerns
  (docs/deployment.md, docs/disaster-recovery.md — written in later stages).

## Revisit when
- Never for the ledger itself. Reporting replicas may be introduced alongside, not
  instead of, the primary.