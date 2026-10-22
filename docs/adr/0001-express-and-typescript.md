# ADR-0001: Express + TypeScript for the FinCore HTTP surface

## Context

FinCore must demonstrate financial correctness, not framework novelty. The team/portfolio
context values readability, a large middleware ecosystem, and easy review by engineers
who know Node.

## Options

1. Express + TypeScript (chosen)
2. NestJS + TypeScript
3. Fastify + TypeScript

## Decision

Express 4 with TypeScript strict, Zod for validation, no DI container in this first stage.

## Consequences

- Pros: minimal magic, thin controllers, easy to test with Supertest, matches the
  requested stack.
- Cons: no built-in DI; we rely on explicit constructor injection.
- Express 5 (still churny) deferred; revisit when it stabilizes. Note in ADR.

## Revisit when

- The route surface exceeds ~200 endpoints and manual DI becomes error-prone.
