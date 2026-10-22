# FinCore

FinCore is a **production-grade, simulated** Nigerian fintech backend demonstrating
double-entry accounting, idempotent transfers, transactional outbox, webhooks,
reconciliation, and production-style operations. It is **not** a real bank, not
licensed, not PCI DSS compliant, not audited, and must never be used to move real money.

## Implemented, Simulated, and Not Yet Implemented

- **Implemented (Phase 0):** project skeleton, strict TypeScript, ESLint, Prettier,
  Zod env validation, Pino logging, request-id middleware, RFC7807-style error handler,
  `/health/live` (real) and `/health/ready` (honestly 503 until deps are wired),
  Vitest + Supertest smoke tests, CI pipeline.
- **Simulated:** (nothing yet — arrives with the payment provider in Phase 5).
- **Not yet implemented:** everything from Phase 1 onward. See `docs/architecture.md`
  for the target and the phases.

## Quickstart (Phase 0)

```bash
npm install
cp .env.example .env
npm run typecheck
npm run lint
npm test
npm run dev   # http://localhost:3000/health/live
```
