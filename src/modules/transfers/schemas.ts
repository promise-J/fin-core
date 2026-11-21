import { z } from 'zod';

import { ProblemDetailsError } from '../../common/errors';

/**
 * The `amount` field is a string like "20000.00".
 * We parse it to kobo via `nairaToKobo` in the service; here we only
 * enforce the shape so we can reject garbage early.
 */
const Amount = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Amount must be a decimal string with at most 2 decimal places.');

export const CreateTransferBody = z.object({
  sourceWalletId: z.string().min(1),
  destinationWalletId: z.string().min(1),
  amount: Amount,
  currency: z.literal('NGN'),
});

export type CreateTransferInput = z.infer<typeof CreateTransferBody>;

export function parseOrThrow<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ProblemDetailsError(400, 'validation_error', 'Request body failed validation.', {
      issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }
  return result.data;
}

export function requireIdempotencyKey(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers['idempotency-key'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProblemDetailsError(
      400,
      'missing_idempotency_key',
      'The Idempotency-Key header is required.',
    );
  }
  if (raw.length > 255) {
    throw new ProblemDetailsError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 255 characters or fewer.',
    );
  }
  return raw;
}