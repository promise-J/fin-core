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
});

async function seedAccounts() {
  await db.ledgerAccount.createMany({
    data: [
      { internalCode: 'FEE_REVENUE_NGN', type: 'FEE_REVENUE', currency: 'NGN' },
      { internalCode: 'PLATFORM_CASH_NGN', type: 'PLATFORM_CASH', currency: 'NGN' },
    ],
  });
}

async function setupUsersWithWallets() {
  await seedAccounts();
  const u1 = await db.user.create({ data: { email: 'a@x.com', passwordHash: 'x', emailVerifiedAt: new Date(), status: 'ACTIVE', kycStatus: 'APPROVED', roles: ['CUSTOMER'] } });
  const u2 = await db.user.create({ data: { email: 'b@x.com', passwordHash: 'x', emailVerifiedAt: new Date(), status: 'ACTIVE', kycStatus: 'APPROVED', roles: ['CUSTOMER'] } });
  const w1 = await db.wallet.create({ data: { ownerId: u1.id, currency: 'NGN', balance: 0n } });
  const w2 = await db.wallet.create({ data: { ownerId: u2.id, currency: 'NGN', balance: 0n } });
  const a1 = await db.ledgerAccount.create({ data: { type: 'CUSTOMER_WALLET', currency: 'NGN', walletId: w1.id } });
  const a2 = await db.ledgerAccount.create({ data: { type: 'CUSTOMER_WALLET', currency: 'NGN', walletId: w2.id } });
  const s1 = await sessions.startSession(u1.id, ['CUSTOMER'], {});
  const s2 = await sessions.startSession(u2.id, ['CUSTOMER'], {});
  return { u1, u2, w1, w2, a1, a2, t1: s1.accessToken, t2: s2.accessToken };
}

// async function fundWallet(_: string, _: string, _: bigint) {
//   const _ = await db.ledgerAccount.findUnique({ where: { internalCode: 'PLATFORM_CASH_NGN' } });
//   await db.$transaction(async (tx) => {
//     await tx.journalEntry.create({ data: { referenceType: 'FUNDING', referenceId: 'seed', transactionType: 'WALLET_FUNDING', currency: 'NGN' } });
//     // ... (or use postJournal; simplest is direct SQL in test setup — see actual file)
//   });
// }

describe('POST /transfers', () => {
  it('happy path: transfers money and updates both wallets', async () => {
    const { w1, w2, a1, t1 } = await setupUsersWithWallets();
    // Seed w1 with 500.00 (50000 kobo) via direct update — tests don't need the funding journal.
    await db.wallet.update({ where: { id: w1.id }, data: { balance: 50_000n } });
    // Also create a matching ledger posting so the deferred trigger is happy.
    const cash = await db.ledgerAccount.findUnique({ where: { internalCode: 'PLATFORM_CASH_NGN' } });
    await db.$transaction(async (tx) => {
      const je = await tx.journalEntry.create({ data: { referenceType: 'FUNDING', referenceId: 'seed', transactionType: 'WALLET_FUNDING', currency: 'NGN' } });
      await tx.ledgerPosting.create({ data: { journalEntryId: je.id, ledgerAccountId: cash!.id, direction: 'DEBIT', amountMinor: 50_000n, currency: 'NGN' } });
      await tx.ledgerPosting.create({ data: { journalEntryId: je.id, ledgerAccountId: a1.id, direction: 'CREDIT', amountMinor: 50_000n, currency: 'NGN' } });
    });

    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${t1}`)
      .set('Idempotency-Key', 'happy-1')
      .send({ sourceWalletId: w1.id, destinationWalletId: w2.id, amount: '100.00', currency: 'NGN' });

    expect(res.status).toBe(201);
    expect(res.body.transfer.status).toBe('COMPLETED');

    const [s, d] = await Promise.all([
      db.wallet.findUnique({ where: { id: w1.id } }),
      db.wallet.findUnique({ where: { id: w2.id } }),
    ]);
    expect(s?.balance).toBe(40_000n);
    expect(d?.balance).toBe(10_000n);

    // Outbox event was written.
    const outbox = await db.outboxEvent.findMany({ where: { aggregateId: res.body.transfer.id } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('transfer.completed.v1');
  });

  it('rejects insufficient funds with 400 and leaves wallets untouched', async () => {
    const { w1, w2, t1 } = await setupUsersWithWallets();
    // w1 has 0
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${t1}`)
      .set('Idempotency-Key', 'broke-1')
      .send({ sourceWalletId: w1.id, destinationWalletId: w2.id, amount: '100.00', currency: 'NGN' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('insufficient_funds');
    // No transfer row, no journal, no outbox.
    expect(await db.transfer.count()).toBe(0);
    expect(await db.journalEntry.count()).toBe(0);
    expect(await db.outboxEvent.count()).toBe(0);
  });

  it('rejects a wallet the caller does not own', async () => {
    const { w1, w2, t2 } = await setupUsersWithWallets();
    // t2 (Bob) tries to send from Alice's wallet.
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${t2}`)
      .set('Idempotency-Key', 'notmine-1')
      .send({ sourceWalletId: w1.id, destinationWalletId: w2.id, amount: '1.00', currency: 'NGN' });
    expect(res.status).toBe(404);
  });
  it('cancel succeeds for PENDING, then a second cancel returns 409', async () => {
    // Set up a transfer by hand (PENDING state), then call cancel.
    const { w1, w2, t1, u1 } = await setupUsersWithWallets();
    const transfer = await db.transfer.create({
      data: { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id,
              amountMinor: 100n, feeMinor: 0n, currency: 'NGN', status: 'PENDING', correlationId: 'c' },
    });
  
    const ok = await request(app)
      .post(`/api/v1/transfers/${transfer.id}/cancel`)
      .set('Authorization', `Bearer ${t1}`);
    expect(ok.status).toBe(200);
  
    const again = await request(app)
      .post(`/api/v1/transfers/${transfer.id}/cancel`)
      .set('Authorization', `Bearer ${t1}`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
  });
});