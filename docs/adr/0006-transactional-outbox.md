# ADR-0006: Transactional outbox for all domain events

## Context

Publishing to RabbitMQ before commit risks announcing state that rolled back.
Publishing after commit risks losing the announcement if the process dies in between.

## Decision

Domain events are rows in an `outbox_events` table written in the same transaction as
the state change. A separate publisher claims rows with FOR UPDATE SKIP LOCKED, publishes
with publisher-confirms, and marks them published only after broker ack. Duplicate
publishes are tolerated; consumers dedupe via an `inbox_processed` table written in the
same transaction as their side effect.

## Consequences

- At-least-once delivery end-to-end. No false claims of exactly-once.
- Requires an operational view for backlog and dead-letters.

## Revisit when

- Never while RabbitMQ is used. If the broker changes, the outbox stays.
