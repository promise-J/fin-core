# FinCore Architecture

## Writen by Johnson Promise

## Status of this document

Describes the target architecture and what is implemented at each stage. The
"Implemented" column is updated only when code for that item exists and passes its tests.

## Shape

Modular monolith (Express + TypeScript) with separately deployed worker processes
sharing the same codebase and container image, differentiated by entrypoint.

## Runtime topology (target, per-stage)

- fincore-api — HTTP surface
- fincore-outbox — transactional outbox publisher
- fincore-notifier — notification consumer
- fincore-reconciler — scheduled reconciliation worker

## Data stores and their authority

- PostgreSQL: system of record for users, wallets, ledger, transfers, payments,
  idempotency, outbox, inbox, reconciliation, audit.
- Redis: rate limiting, short-lived cache, coordination. NOT authoritative for money.
  Must be safe to drop Redis with no financial-correctness impact.
- RabbitMQ: at-least-once delivery of domain events out of the outbox. Consumers dedupe.

## Request path (target)

client → ALB → Express (authn → authz → validation → service → repository → PG)
↘ outbox insert (same TX)
worker (outbox-publisher) → RabbitMQ → consumers → PG (inbox dedupe in same TX)

## Failure posture

- Provider uncertainty is modeled explicitly (see financial-domain.md INV-7).
- Outbox closes the "committed but never published" window (INV-8).
- Inbox closes the "delivered twice" window (INV-9).
- Idempotency-key store closes the "duplicate request" window (INV-6).

## What is NOT in this document

- No Kubernetes for now.
- No microservices split for now.
- No claim of PCI/regulatory compliance. See README "Implemented, Simulated, and
  Not Yet Implemented".
