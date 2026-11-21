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
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "OutboxEvent","LedgerPosting","JournalEntry","Transfer","IdempotencyRecord","LedgerAccount","Wallet","Session","User"
    RESTART IDENTITY CASCADE
  `);
  await db.ledgerAccount.createMany({
    data: [
      { internalCode: 'FEE_REVENUE_NGN', type: 'FEE_REVENUE', currency: 'NGN' },
      { internalCode: 'PLATFORM_CASH_NGN', type: 'PLATFORM_CASH', currency: 'NGN' },
    ],
  });
});

async function setupFundedWallet(balanceMinor: bigint) {
  const u = await db.user.create({ data: { email: `u${Math.random()}@x.com`, passwordHash: 'x', emailVerifiedAt: new Date(), status: 'ACTIVE', kycStatus: 'APPROVED', roles: ['CUSTOMER'] } });
  const w = await db.wallet.create({ data: { ownerId: u.id, currency: 'NGN', balance: balanceMinor } });
  const a = await db.ledgerAccount.create({ data: { type: 'CUSTOMER_WALLET', currency: 'NGN', walletId: w.id } });
  const cash = await db.ledgerAccount.findUnique({ where: { internalCode: 'PLATFORM_CASH_NGN' } });
  await db.$transaction(async (tx) => {
    const je = await tx.journalEntry.create({ data: { referenceType: 'FUNDING', referenceId: 'seed', transactionType: 'WALLET_FUNDING', currency: 'NGN' } });
    await tx.ledgerPosting.create({ data: { journalEntryId: je.id, ledgerAccountId: cash!.id, direction: 'DEBIT', amountMinor: balanceMinor, currency: 'NGN' } });
    await tx.ledgerPosting.create({ data: { journalEntryId: je.id, ledgerAccountId: a.id, direction: 'CREDIT', amountMinor: balanceMinor, currency: 'NGN' } });
  });
  const s = await sessions.startSession(u.id, ['CUSTOMER'], {});
  return { user: u, wallet: w, token: s.accessToken };
}

describe('transfer concurrency', () => {
  it('10 transfers of 100 each against a 500 balance: only 5 succeed', async () => {
    const src = await setupFundedWallet(50_000n); // 500.00
    const dst = await setupFundedWallet(0n);

    const attempts = Array.from({ length: 10 }, (_, i) =>
      request(app)
        .post('/api/v1/transfers')
        .set('Authorization', `Bearer ${src.token}`)
        .set('Idempotency-Key', `race-${i}`)
        .send({ sourceWalletId: src.wallet.id, destinationWalletId: dst.wallet.id, amount: '100.00', currency: 'NGN' }),
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.status === 201).length;
    const failedFunds = results.filter((r) => r.status === 400 && r.body.code === 'insufficient_funds').length;

    expect(succeeded).toBe(5);
    expect(failedFunds).toBe(5);

    const srcAfter = await db.wallet.findUnique({ where: { id: src.wallet.id } });
    const dstAfter = await db.wallet.findUnique({ where: { id: dst.wallet.id } });
    expect(srcAfter?.balance).toBe(0n);
    expect(dstAfter?.balance).toBe(50_000n);
    expect(srcAfter!.balance >= 0n).toBe(true);
  });

  it('10 concurrent requests with the same idempotency key: exactly 1 succeeds', async () => {
    const src = await setupFundedWallet(50_000n);
    const dst = await setupFundedWallet(0n);

    const attempts = Array.from({ length: 10 }, () =>
      request(app)
        .post('/api/v1/transfers')
        .set('Authorization', `Bearer ${src.token}`)
        .set('Idempotency-Key', 'same-key')
        .send({ sourceWalletId: src.wallet.id, destinationWalletId: dst.wallet.id, amount: '100.00', currency: 'NGN' }),
    );

    const results = await Promise.all(attempts);
    const success = results.filter((r) => r.status === 201);
    // const inProgress = results.filter((r) => r.status === 409 && r.body.code === 'idempotency_in_progress');

    // Exactly one wins. Everyone else gets either a replay of the
    // winner (201) or in_progress (409). Never two 201s.
    expect(success.length).toBeGreaterThanOrEqual(1);
    expect(success.every((r) => r.body.transfer.id === success[0]!.body.transfer.id)).toBe(true);

    // Destination received exactly 100 (once).
    const dstAfter = await db.wallet.findUnique({ where: { id: dst.wallet.id } });
    expect(dstAfter?.balance).toBe(10_000n);
  });

  it('opposing transfers between two wallets do not deadlock', async () => {
    const a = await setupFundedWallet(10_000n);
    const b = await setupFundedWallet(10_000n);

    // a → b and b → a simultaneously. Lock order must be by id.
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/v1/transfers')
        .set('Authorization', `Bearer ${a.token}`)
        .set('Idempotency-Key', 'opp-1')
        .send({ sourceWalletId: a.wallet.id, destinationWalletId: b.wallet.id, amount: '50.00', currency: 'NGN' }),
      request(app)
        .post('/api/v1/transfers')
        .set('Authorization', `Bearer ${b.token}`)
        .set('Idempotency-Key', 'opp-2')
        .send({ sourceWalletId: b.wallet.id, destinationWalletId: a.wallet.id, amount: '50.00', currency: 'NGN' }),
    ]);

    // Both should succeed; no deadlock.
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Net: both wallets back to 100.00.
    const aAfter = await db.wallet.findUnique({ where: { id: a.wallet.id } });
    const bAfter = await db.wallet.findUnique({ where: { id: b.wallet.id } });
    expect(aAfter?.balance).toBe(10_000n);
    expect(bAfter?.balance).toBe(10_000n);
  });

  it('same key + different body: one succeeds, the other gets idempotency_conflict', async () => {
    const src = await setupFundedWallet(50_000n);
    const dst = await setupFundedWallet(0n);

    const r1 = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${src.token}`)
      .set('Idempotency-Key', 'same-key-diff-body')
      .send({ sourceWalletId: src.wallet.id, destinationWalletId: dst.wallet.id, amount: '100.00', currency: 'NGN' });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${src.token}`)
      .set('Idempotency-Key', 'same-key-diff-body')
      .send({ sourceWalletId: src.wallet.id, destinationWalletId: dst.wallet.id, amount: '200.00', currency: 'NGN' });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('idempotency_conflict');

    // Only 100 moved.
    const dstAfter = await db.wallet.findUnique({ where: { id: dst.wallet.id } });
    expect(dstAfter?.balance).toBe(10_000n);
  });
});