import { z } from 'zod';

import { ProblemDetailsError } from '../../common/errors.js';


const Password = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(128, 'Password must be at most 128 characters.');

const Email = z
  .email('Invalid email address.')
  .max(254)
  .transform((s) => s.toLowerCase());

export const RegisterBody = z.object({
  email: Email,
  password: Password,
  fullName: z.string().min(3).max(200).optional(),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{7,15}$/, 'Invalid phone number.')
    .optional(),
});

export const LoginBody = z.object({
  email: Email,
  password: z.string().min(1).max(128),
});

export const RefreshBody = z.object({
  refreshToken: z.string().min(1).max(512),
});

export const LogoutBody = z.object({
  refreshToken: z.string().min(1).max(512),
});

export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;
export type RefreshInput = z.infer<typeof RefreshBody>;
export type LogoutInput = z.infer<typeof LogoutBody>;


export function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ProblemDetailsError(
      400,
      'validation_error',
      'Request body failed validation.',
      { issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    );
  }
  return result.data;
}