

import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('fincore-api'),
  DATABASE_URL: z.url().optional()
}).superRefine((env, ctx)=>{
  if(env.NODE_ENV === 'production' && !env.DATABASE_URL) {
    ctx.addIssue({code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL is required in production'});
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${summary}`);
  }
  return parsed.data;
}
