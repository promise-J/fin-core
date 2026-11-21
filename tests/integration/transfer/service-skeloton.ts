import { execSync } from 'node:child_process';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { loadEnv } from '../../../src/config/env';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';
import { buildTransferService } from '../../../src/modules/transfers/service';

let container: StartedPostgreSqlContainer;
let db: Db;
let service: ReturnType<typeof buildTransferService>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('fincore_test').withUsername('fincore').withPassword('fincore').start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url, JWT_ACCESS_SECRET: 'a'.repeat(32), REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv);
  db = buildPrisma(env);
  service = buildTransferService({ db });
}, 120_000);

afterAll(async () => { await db?.$disconnect(); await container?.stop(); });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "LedgerPosting","JournalEntry","Transfer","LedgerAccount","Wallet","Session","User" RESTART IDENTITY CASCADE');
});

async function setup() {
  const u1 = await db.user.create({ data: { email: 'a@t.com', passwordHash: 'x', emailVerifiedAt: new Date(), status: 'ACTIVE', kycStatus: 'APPROVED', roles: ['CUSTOMER'] } });
  const u2 = await db.user.create({ data: { email: 'b@t.com', passwordHash: 'x', emailVerifiedAt: new Date(), status: 'ACTIVE', kycStatus: 'APPROVED', roles: ['CUSTOMER'] } });
  const w1 = await db.wallet.create({ data: { ownerId: u1.id, currency: 'NGN', balance: 1000n } });
  const w2 = await db.wallet.create({ data: { ownerId: u2.id, currency: 'NGN', balance: 0n } });
  return { u1, u2, w1, w2 };
}

describe('transfer service skeleton', () => {
  it('createPending writes a PENDING row', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, {
        initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id,
        amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c1',
      }),
    );
    expect(t.status).toBe('PENDING');
  });

  it('rejects same-wallet transfer', async () => {
    const { u1, w1 } = await setup();
    await expect(
      db.$transaction((tx) =>
        service.createPending(tx, {
          initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w1.id,
          amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c',
        }),
      ),
    ).rejects.toMatchObject({ code: 'same_wallet' });
  });

  it('markProcessing: PENDING → PROCESSING', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id, amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c' }),
    );
    const p = await db.$transaction((tx) => service.markProcessing(tx, t.id));
    expect(p.status).toBe('PROCESSING');
  });

  it('markProcessing refuses a transfer that is already PROCESSING', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id, amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c' }),
    );
    await db.$transaction((tx) => service.markProcessing(tx, t.id));
    await expect(
      db.$transaction((tx) => service.markProcessing(tx, t.id)),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('cancel: PENDING → CANCELLED', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id, amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c' }),
    );
    const c = await db.$transaction((tx) => service.cancel(tx, t.id));
    expect(c.status).toBe('CANCELLED');
  });

  it('cancel refuses PROCESSING', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id, amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c' }),
    );
    await db.$transaction((tx) => service.markProcessing(tx, t.id));
    await expect(
      db.$transaction((tx) => service.cancel(tx, t.id)),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('markFailed: PROCESSING → FAILED', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id, amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c' }),
    );
    await db.$transaction((tx) => service.markProcessing(tx, t.id));
    const f = await db.$transaction((tx) => service.markFailed(tx, t.id, 'transient', 'retry later'));
    expect(f.status).toBe('FAILED');
    expect(f.failureCode).toBe('transient');
  });

  it('markCompleted throws not_implemented in 4.1', async () => {
    const { u1, w1, w2 } = await setup();
    const t = await db.$transaction((tx) =>
      service.createPending(tx, { initiatorId: u1.id, sourceWalletId: w1.id, destinationWalletId: w2.id, amountMinor: 100n, feeMinor: 0n, currency: 'NGN', correlationId: 'c' }),
    );
    await expect(
      db.$transaction((tx) => service.markCompleted(tx, t.id, 'whatever')),
    ).rejects.toMatchObject({ code: 'not_implemented' });
  });
});