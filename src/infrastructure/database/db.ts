import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { Env } from '../../config/env';

/**
 * Build a Prisma client bound to the given env.
 * We deliberately do not export a module-level singleton:
 * the app, tests, and workers each need their own client,
 * and construction should be explicit at the composition root.
 */
export function buildPrisma(env: Env): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export type Db = PrismaClient;