# ADR-0005: Idempotency keys enforced in PostgreSQL

## Context

Clients retry. Networks duplicate. Redis-based idempotency is fast but can be lost on
eviction or broker failover, which would be catastrophic for a money-moving endpoint.

## Decision

Idempotency records live in PostgreSQL with a UNIQUE (scope, key) constraint, storing
request fingerprint + status + resulting resource id + serialized response. Concurrent
duplicates hit the unique constraint and are handled by re-reading the winner's row.
In-flight duplicates receive 409 + Retry-After.

## Consequences

- Slightly higher write latency per transfer (one extra insert).
- Correctness does not depend on Redis.

## Revisit when

- Never for money endpoints. Non-money endpoints may adopt Redis-backed keys.
