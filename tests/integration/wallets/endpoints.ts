import { execSync } from 'node:child_process';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { buildApp } from '../../../src/app';
import { loadEnv } from '../../../src/config/env';
import { buildLogger } from '../../../src/config/logger';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';
import { buildSessionService } from '../../../src/modules/auth/session-service';

let container: StartedPostgreSqlContainer;
let db: Db;
let env: ReturnType<typeof loadEnv>;
let app: ReturnType<typeof buildApp>;
let sessions: ReturnType<typeof buildSessionService>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('fincore_test').withUsername('fincore').withPassword('fincore').start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  env = loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url, JWT_ACCESS_SECRET: 'a'.repeat(32), REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv);
  db = buildPrisma(env);
  sessions = buildSessionService({ db, env });
const logger = buildLogger({ LOG_LEVEL: 'silent', SERVICE_NAME: 'test', NODE_ENV: 'test', REDIS_URL: env.REDIS_URL, DATABASE_URL: env.DATABASE_URL, JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET });
  app = buildApp({ env, logger, db });
}, 120_000);

afterAll(async () => { await db?.$disconnect(); await container?.stop(); });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "LedgerPosting","JournalEntry","LedgerAccount","Wallet","Session","User" RESTART IDENTITY CASCADE');
});

async function userAndToken(email: string) {
  const user = await db.user.create({
    data: { email, passwordHash: 'x', emailVerifiedAt: new Date(), status: 'ACTIVE', kycStatus: 'APPROVED', roles: ['CUSTOMER'] },
  });
  const auth = await sessions.startSession(user.id, user.roles, {});
  return { user, token: auth.accessToken };
}

describe('wallets endpoints', () => {
  it('POST / creates a wallet and its ledger account atomically', async () => {
    const { token } = await userAndToken('w1@example.com');
    const res = await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.wallet.currency).toBe('NGN');
    expect(res.body.wallet.balanceMinor).toBe('0');

    const account = await db.ledgerAccount.findUnique({ where: { walletId: res.body.wallet.id } });
    expect(account?.type).toBe('CUSTOMER_WALLET');
  });

  it('POST / returns 409 on duplicate currency for same user', async () => {
    const { token } = await userAndToken('w2@example.com');
    await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${token}`).send({});
    const res = await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('wallet_exists');
  });

  it('GET / lists only the caller\'s wallets', async () => {
    const a = await userAndToken('a@example.com');
    const b = await userAndToken('b@example.com');
    await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${a.token}`).send({});
    await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${b.token}`).send({});

    const res = await request(app).get('/api/v1/wallets').set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.wallets).toHaveLength(1);
    expect(res.body.wallets[0].ownerId).toBe(a.user.id);
  });

  it('GET /:id returns 404 for another user\'s wallet', async () => {
    const a = await userAndToken('a2@example.com');
    const b = await userAndToken('b2@example.com');
    const created = await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${a.token}`).send({});
    const res = await request(app).get(`/api/v1/wallets/${created.body.wallet.id}`).set('Authorization', `Bearer ${b.token}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id/balance returns both minor units and decimal', async () => {
    const { token } = await userAndToken('bal@example.com');
    const created = await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${token}`).send({});
    const id = created.body.wallet.id;
    const res = await request(app).get(`/api/v1/wallets/${id}/balance`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.balanceMinor).toBe('0');
    expect(res.body.balance).toBe('0.00');
  });

  it('rejects unauthenticated access', async () => {
    const res = await request(app).get('/api/v1/wallets');
    expect(res.status).toBe(401);
  });
});

it('GET /:id/statement returns journal entries for the wallet', async () => {
  const { token } = await userAndToken('st@example.com');
  const created = await request(app).post('/api/v1/wallets').set('Authorization', `Bearer ${token}`).send({});
  const walletId = created.body.wallet.id;

  // Fund via the ledger primitive directly.
  const { postJournal } = await import('../../../src/modules/ledger/post');
  const account = await db.ledgerAccount.findUnique({ where: { walletId } });
  const cash = await db.ledgerAccount.create({ data: { type: 'PLATFORM_CASH', currency: 'NGN', internalCode: 'ST_CASH' } });
  await db.$transaction(async (tx) => {
    await postJournal(tx, {
      referenceType: 'FUNDING', referenceId: 'stf1', transactionType: 'WALLET_FUNDING', currency: 'NGN',
      postings: [
        { ledgerAccountId: cash.id, direction: 'DEBIT', amountMinor: 500n },
        { ledgerAccountId: account!.id, direction: 'CREDIT', amountMinor: 500n },
      ],
      updates: [{ walletId, deltaMinor: 500n }],
    });
  });

  const res = await request(app).get(`/api/v1/wallets/${walletId}/statement`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.rows).toHaveLength(1);
  expect(res.body.rows[0].direction).toBe('CREDIT');
  expect(res.body.rows[0].amountMinor).toBe('500');
});