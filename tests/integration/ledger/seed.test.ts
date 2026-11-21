import { execSync } from 'node:child_process';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { loadEnv } from '../../../src/config/env';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';

let container: StartedPostgreSqlContainer;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').withDatabase('fincore_test').withUsername('fincore').withPassword('fincore').start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url, JWT_ACCESS_SECRET: 'a'.repeat(32), REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv);
  db = buildPrisma(env);
}, 120_000);

afterAll(async () => { await db?.$disconnect(); await container?.stop(); });

describe('seed internal accounts', () => {
  it('creates all six accounts on first run', async () => {
    execSync('npx tsx prisma/seed.ts', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'inherit',
    });
    const count = await db.ledgerAccount.count({ where: { internalCode: { not: null } } });
    expect(count).toBe(6);
  });

  it('is idempotent', async () => {
    execSync('npx tsx prisma/seed.ts', { env: { ...process.env, DATABASE_URL: container.getConnectionUri() }, stdio: 'inherit' });
    execSync('npx tsx prisma/seed.ts', { env: { ...process.env, DATABASE_URL: container.getConnectionUri() }, stdio: 'inherit' });
    const count = await db.ledgerAccount.count({ where: { internalCode: { not: null } } });
    expect(count).toBe(6);
  });
});