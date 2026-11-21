import { z } from 'zod';

import { ProblemDetailsError } from '../../common/errors';

export const CreateWalletBody = z.object({
  // NGN only at launch; the field exists for future currencies.
  currency: z.enum(['NGN']).default('NGN'),
});

export type CreateWalletInput = z.infer<typeof CreateWalletBody>;

export function parseOrThrow<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ProblemDetailsError(400, 'validation_error', 'Request body failed validation.', {
      issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }
  return result.data;
}