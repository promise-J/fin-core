import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';

// const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Canonicalize a request body into a stable fingerprint.
 * Key sort: ensures {a:1, b:2} and {b:2, a:1} hash identically.
 * Any change to the request body must change the fingerprint,
 * otherwise "same key, different body" won't be detected.
 */
export function fingerprint(body: unknown): string {
  const canonical = JSON.stringify(body, Object.keys(body as object).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyContext {
  scope: string;
  key: string;
  userId: string | null;
  requestFingerprint: string;
}

export function buildIdempotencyService(db: Db) {
  return {
    /**
     * Run `operation` at most once per (scope, key).
     *
     * Cases:
     *   1. No existing record          → run, store result, return.
     *   2. Existing COMPLETED, same fp → return stored result, don't run.
     *   3. Existing COMPLETED, diff fp → throw 409 idempotency_conflict.
     *   4. Existing IN_PROGRESS, same fp → throw 409 idempotency_in_progress.
     *   5. Existing IN_PROGRESS, diff fp → throw 409 idempotency_conflict.
     *   6. Existing FAILED, same fp    → throw 409 idempotency_failed (rare; see notes).
     *
     * `operation` runs inside a transaction that also holds the
     * idempotency record's lock — so no two concurrent callers with the
     * same key can both execute the operation.
     */
    async run<T = unknown>(
      ctx: IdempotencyContext,
      operation: (tx: Prisma.TransactionClient) => Promise<StoredResponse & { resourceId?: string }>,
    ): Promise<StoredResponse> {
      return db.$transaction(async (tx) => {
        // Step 1: try to claim the idempotency key.
        // ON CONFLICT DO NOTHING means: if another request already
        // created a row for this key, we don't error — we fall through
        // and read the existing row.
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "IdempotencyRecord"
            (id, scope, key, "userId", "requestFingerprint", status, "createdAt", "updatedAt", "expiresAt")
          VALUES
            (gen_random_uuid()::text, ${ctx.scope}, ${ctx.key}, ${ctx.userId}, ${ctx.requestFingerprint}, 'IN_PROGRESS'::"IdempotencyStatus", now(), now(), now() + interval '1 day')
          ON CONFLICT (scope, key) DO NOTHING
          RETURNING id
        `;

        if (inserted.length === 1) {
          // We claimed the key. Run the operation and store the result
          // in the same transaction. If the operation throws, the entire
          // transaction rolls back — including the idempotency row — so
          // a retry with the same key will attempt the operation again.
          const result = await operation(tx);
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope: ctx.scope, key: ctx.key } },
            data: {
              status: 'COMPLETED',
              responseStatus: result.status,
              responseBody: result.body as Prisma.InputJsonValue,
              resourceId: result.resourceId ?? null,
            },
          });
          return result;
        }

        // Somebody else has (or had) the key. Read and inspect.
        const existing = await tx.idempotencyRecord.findUnique({
          where: { scope_key: { scope: ctx.scope, key: ctx.key } },
        });
        if (!existing) {
          // Extremely unlikely: row was inserted and deleted between
          // our INSERT and our SELECT. Treat as in-progress and ask
          // the client to retry.
          throw new ProblemDetailsError(
            409,
            'idempotency_in_progress',
            'A request with this idempotency key is currently being processed. Retry shortly.',
          );
        }

        if (existing.requestFingerprint !== ctx.requestFingerprint) {
          throw new ProblemDetailsError(
            409,
            'idempotency_conflict',
            'This idempotency key has already been used with a different request body.',
          );
        }

        if (existing.status === 'COMPLETED') {
          return {
            status: existing.responseStatus!,
            body: existing.responseBody as T,
          };
        }

        if (existing.status === 'IN_PROGRESS') {
          throw new ProblemDetailsError(
            409,
            'idempotency_in_progress',
            'A request with this idempotency key is currently being processed. Retry shortly.',
          );
        }

        // FAILED: shouldn't happen, because we roll back the row on
        // operation failure. Defensive reject.
        throw new ProblemDetailsError(
          409,
          'idempotency_failed',
          'A previous request with this idempotency key failed. Use a new key to retry.',
        );
      });
    },
  };
}

export type IdempotencyService = ReturnType<typeof buildIdempotencyService>;