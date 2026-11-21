import { execSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { buildFileMailSender } from '../../../src/infrastructure/mail/console-mail-sender';

let container: StartedPostgreSqlContainer;
let db: Db;
let env: ReturnType<typeof loadEnv>;
let app: ReturnType<typeof buildApp>;
let mailDir: string;

beforeAll(async () => {
  mailDir = join(tmpdir(), `fincore-mail-${Date.now()}`);
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
    MAIL_OUTBOX_PATH: mailDir,
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
    'TRUNCATE TABLE "EmailOutbox", "EmailVerificationToken", "Session", "User" RESTART IDENTITY CASCADE',
  );
});

const PASSWORD = 'correct horse battery staple';

async function lastRawTokenFromDb(_: string): Promise<string> {
  // The raw token is only known to the caller of issue(). We can't recover it
  // from the hash. For testing, we replicate what the app does: read the
  // generated raw token out of the mail body written by the worker.
  const files = await readdir(mailDir).catch(() => []);
  const latest = files.sort().at(-1);
  if (!latest) throw new Error('no email files yet');
  const content = await readFile(join(mailDir, latest), 'utf8');
  const match = content.match(/verify-email\?token=([^\s]+)/);
  if (!match) throw new Error('no token in email body');
  return decodeURIComponent(match[1]!);
}

describe('email verification', () => {
  it('register enqueues an email and creates a PENDING_VERIFICATION user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'v1@example.com', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.status).toBe('PENDING_VERIFICATION');

    const out = await db.emailOutbox.findMany();
    expect(out).toHaveLength(1);
    expect(out[0]!.toAddress).toBe('v1@example.com');
    expect(out[0]!.status).toBe('PENDING');
  });

  it('login is rejected until the user is verified', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'v2@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'v2@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('email_not_verified');
  });

  it('verify-email consumes the token and makes login work', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'v3@example.com', password: PASSWORD });

    // Drain the outbox by "sending" the email (same sender the worker uses).
    const mailer = buildFileMailSender(mailDir);
    const queued = await db.emailOutbox.findMany({ where: { status: 'PENDING' } });
    for (const row of queued) {
      await mailer.send({
        to: row.toAddress,
        subject: row.subject,
        bodyText: row.bodyText,
        bodyHtml: row.bodyHtml ?? undefined,
      });
      await db.emailOutbox.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    }

    const token = await lastRawTokenFromDb('');
    const ok = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token });
    expect(ok.status).toBe(204);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'v3@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('verify-email rejects an already-used token', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'v4@example.com', password: PASSWORD });

    const queued = await db.emailOutbox.findMany({ where: { status: 'PENDING' } });
    const mailer = buildFileMailSender(mailDir);
    for (const row of queued) {
      await mailer.send({ to: row.toAddress, subject: row.subject, bodyText: row.bodyText, bodyHtml: row.bodyHtml ?? undefined });
      await db.emailOutbox.update({ where: { id: row.id }, data: { status: 'SENT' } });
    }
    const token = await lastRawTokenFromDb('');

    await request(app).post('/api/v1/auth/verify-email').send({ token });
    const again = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('token_already_used');
  });
});