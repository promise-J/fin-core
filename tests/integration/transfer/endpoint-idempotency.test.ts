import { execSync } from 'node:child_process';

import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { buildApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';
import { buildLogger } from '../../../src/config/logger.js';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db.js';
import { buildSessionService } from '../../../src/modules/auth/session-service.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let app: ReturnType<typeof buildApp>;
let sessions: ReturnType<typeof buildSessionService>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('fincore_test')
    .withUsername('fincore')
    .withPassword('fincore')
    .start();

  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
  } as NodeJS.ProcessEnv);

  const logger = buildLogger(env);
  db = buildPrisma(env);
  sessions = buildSessionService({ db, env });
  app = buildApp({ env, logger, db });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "IdempotencyRecord", "Session", "User" RESTART IDENTITY CASCADE',
  );
});

async function makeAuthToken(): Promise<string> {
  const user = await db.user.create({
    data: {
      email: 'sender@example.com',
      passwordHash: 'fake-hash',
      fullName: 'Test Sender',
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      roles: ['CUSTOMER'],
    },
  });
  const auth = await sessions.startSession(user.id, user.roles, {});
  return auth.accessToken;
}

describe('POST /api/v1/transfers idempotency & validation', () => {
  it('POST /transfers with no Idempotency-Key → 400', async () => {
    const token = await makeAuthToken();
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceWalletId: 'a',
        destinationWalletId: 'b',
        amount: '10.00',
        currency: 'NGN',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_idempotency_key');
  });

  it('POST /transfers with key but invalid body → 400 validation_error', async () => {
    const token = await makeAuthToken();
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'test-key-1')
      .send({ amount: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });
});
