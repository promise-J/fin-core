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
let env: ReturnType<typeof loadEnv>;
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

  env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
  } as NodeJS.ProcessEnv);

  db = buildPrisma(env);
  sessions = buildSessionService({ db, env });
const logger = buildLogger({ LOG_LEVEL: 'silent', SERVICE_NAME: 'test', NODE_ENV: 'test', REDIS_URL: env.REDIS_URL, DATABASE_URL: env.DATABASE_URL, JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET });
  app = buildApp({ env, logger, db });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "Session", "User" RESTART IDENTITY CASCADE',
  );
});

async function makeUserAndSession() {
  const user = await db.user.create({
    data: {
      email: 'me@example.com',
      passwordHash: 'fake',
      fullName: 'Me',
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      roles: ['CUSTOMER'],
    },
  });
  const auth = await sessions.startSession(user.id, user.roles, {});
  return { user, auth };
}

describe('GET /api/v1/auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const { user, auth } = await makeUserAndSession();
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${auth.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe('me@example.com');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a missing Authorization header', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_authorization');
  });

  it('rejects a malformed bearer token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_access_token');
  });

  it('rejects an expired access token', async () => {
    const { auth } = await makeUserAndSession();
    // Forge an expired token using the same secret.
    const jwt = (await import('jsonwebtoken')).default;
    const expired = jwt.sign(
      { sub: 'u', sid: auth.sessionId, roles: ['CUSTOMER'] },
      env.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: -10,
        issuer: env.SERVICE_NAME,
        audience: env.SERVICE_NAME,
      },
    );
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });
});