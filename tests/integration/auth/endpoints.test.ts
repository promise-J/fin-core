import { execSync } from 'node:child_process';

import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { buildApp } from '../../../src/app';
import { loadEnv } from '../../../src/config/env';
import { buildLogger } from '../../../src/config/logger';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';


let container: StartedPostgreSqlContainer;
let db: Db;
let env: ReturnType<typeof loadEnv>;
let app: ReturnType<typeof buildApp>;

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

const PASSWORD = 'correct horse battery staple';

describe('auth endpoints — full flow', () => {
  it('register returns tokens and creates an ACTIVE user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'a@example.com', password: PASSWORD, fullName: 'A' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.roles).toEqual(['CUSTOMER']);

    const user = await db.user.findUnique({ where: { email: 'a@example.com' } });
    expect(user?.status).toBe('ACTIVE');
    // Stored hash is Argon2id, not plaintext.
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('register rejects a duplicate email with 409', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'dup@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'DUP@example.com', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_in_use');
  });

  it('register rejects short password with 400 validation_error', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'x@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('login succeeds with correct credentials', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'b@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'b@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('login returns 401 invalid_credentials for wrong password', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'c@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'c@example.com', password: 'wrong password here' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_credentials');
  });

  it('login returns 401 invalid_credentials for unknown email (no enumeration)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    // Same code as wrong-password case.
    expect(res.body.code).toBe('invalid_credentials');
  });

  it('refresh rotates the cookie and revokes the old one', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'd@example.com', password: PASSWORD });
    const cookie1 = refreshCookieFrom(reg);
  
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie1);
    expect(res.status).toBe(200);
    const cookie2 = refreshCookieFrom(res);
    expect(cookie2).not.toBe(cookie1);
  
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie1); // old cookie
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('refresh_token_reused');
  });

  it('logout revokes the session and a subsequent refresh fails', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'e@example.com', password: PASSWORD });
    const refreshToken = reg.body.refreshToken;

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken });
    expect(out.status).toBe(204);

    const refreshAfter = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshAfter.status).toBe(401);
  });

  it('logout-all revokes every session for the user', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'f@example.com', password: PASSWORD });
    const accessToken = reg.body.accessToken;
    const refresh1 = reg.body.refreshToken;

    // Create a second session via login.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'f@example.com', password: PASSWORD });
    const refresh2 = login.body.refreshToken;

    const out = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(out.status).toBe(204);

    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refresh1 });
    const r2 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refresh2 });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });

  it('me works with the access token returned by register', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'g@example.com', password: PASSWORD });
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('g@example.com');
  });
});

it('logout clears the cookie and a subsequent refresh fails', async () => {
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'e@example.com', password: PASSWORD });
  const cookie = refreshCookieFrom(reg);

  const out = await request(app)
    .post('/api/v1/auth/logout')
    .set('Cookie', cookie);
  expect(out.status).toBe(204);

  const refreshAfter = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', cookie);
  expect(refreshAfter.status).toBe(401);
});

function refreshCookieFrom(res: request.Response): string {
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.find((c) => c.startsWith('refresh_token='));
  if (!cookie) throw new Error('no refresh cookie in response');
  return cookie.split(';')[0]; // "refresh_token=..."
}