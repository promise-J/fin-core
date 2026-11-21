import { execSync } from 'node:child_process';

import { LedgerAccountType } from '@prisma/client';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { loadEnv } from '../../../src/config/env';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';
// import { buildLedgerAccountsService } from '../../../src/modules/ledger/accounts';
import { computeWalletBalanceFromLedger } from '../../../src/modules/ledger/balance';
import { postJournal } from '../../../src/modules/ledger/post';

let container: StartedPostgreSqlContainer;
let db: Db;
// let accounts: ReturnType<typeof buildLedgerAccountsService>;

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
  db = buildPrisma(env);
//   accounts = buildLedgerAccountsService(db);
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "LedgerPosting", "JournalEntry", "LedgerAccount", "Wallet", "Session", "User" RESTART IDENTITY CASCADE',
  );
});

async function makeUser(email = 'ledger@example.com') {
  return db.user.create({
    data: {
      email,
      passwordHash: 'fake',
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      roles: ['CUSTOMER'],
    },
  });
}

async function makeWallet(userId: string) {
  const wallet = await db.wallet.create({
    data: { ownerId: userId, currency: 'NGN', balance: 0n },
  });
  const account = await db.ledgerAccount.create({
    data: { type: 'CUSTOMER_WALLET', currency: 'NGN', walletId: wallet.id },
  });
  return { wallet, account };
}

async function makeInternal(code: string, type: LedgerAccountType = 'PLATFORM_CASH') {
  return db.ledgerAccount.create({
    data: { type, currency: 'NGN', internalCode: code },
  });
}

describe('postJournal', () => {
  it('creates a balanced journal and updates the wallet projection', async () => {
    const user = await makeUser();
    const { wallet, account } = await makeWallet(user.id);
    const cash = await makeInternal('CASH1');

    await db.$transaction(async (tx) => {
      await postJournal(tx, {
        referenceType: 'FUNDING',
        referenceId: 'f1',
        transactionType: 'WALLET_FUNDING',
        currency: 'NGN',
        postings: [
          { ledgerAccountId: cash.id, direction: 'DEBIT', amountMinor: 100_00n },
          { ledgerAccountId: account.id, direction: 'CREDIT', amountMinor: 100_00n },
        ],
        updates: [{ walletId: wallet.id, deltaMinor: 100_00n }],
      });
    });

    const balance = await db.wallet.findUnique({ where: { id: wallet.id } });
    expect(balance?.balance).toBe(100_00n);

    const ledgerBalance = await computeWalletBalanceFromLedger(db, wallet.id);
    expect(ledgerBalance).toBe(100_00n);
  });

  it('rejects an unbalanced journal BEFORE the DB sees it', async () => {
    const user = await makeUser();
    const { wallet, account } = await makeWallet(user.id);
    const cash = await makeInternal('CASH2');

    await expect(
      db.$transaction(async (tx) => {
        await postJournal(tx, {
          referenceType: 'FUNDING',
          referenceId: 'f2',
          transactionType: 'WALLET_FUNDING',
          currency: 'NGN',
          postings: [
            { ledgerAccountId: cash.id, direction: 'DEBIT', amountMinor: 100n },
            { ledgerAccountId: account.id, direction: 'CREDIT', amountMinor: 99n },
          ],
          updates: [{ walletId: wallet.id, deltaMinor: 99n }],
        });
      }),
    ).rejects.toMatchObject({ code: 'unbalanced_journal' });

    // Nothing was created.
    const count = await db.journalEntry.count();
    expect(count).toBe(0);
    expect((await db.wallet.findUnique({ where: { id: wallet.id } }))?.balance).toBe(0n);
  });

  it('rejects a journal with fewer than two postings', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await postJournal(tx, {
          referenceType: 'FUNDING',
          referenceId: 'f3',
          transactionType: 'WALLET_FUNDING',
          currency: 'NGN',
          postings: [],
          updates: [],
        });
      }),
    ).rejects.toMatchObject({ code: 'invalid_journal' });
  });

  it('rejects a journal whose wallet projection is missing (via DB trigger)', async () => {
    const user = await makeUser();
    const { account } = await makeWallet(user.id);
    const cash = await makeInternal('CASH4');

    await expect(
      db.$transaction(async (tx) => {
        await postJournal(tx, {
          referenceType: 'FUNDING',
          referenceId: 'f4',
          transactionType: 'WALLET_FUNDING',
          currency: 'NGN',
          postings: [
            { ledgerAccountId: cash.id, direction: 'DEBIT', amountMinor: 100n },
            { ledgerAccountId: account.id, direction: 'CREDIT', amountMinor: 100n },
          ],
          // Deliberately forget the wallet update — the DB trigger must catch it.
          updates: [],
        });
      }),
    ).rejects.toThrow(/balance drift/i);
  });

  it('supports multiple postings per journal (fee split)', async () => {
    const user = await makeUser();
    const { wallet, account } = await makeWallet(user.id);
    const cash = await makeInternal('CASH5');
    const fees = await makeInternal('FEES5', 'FEE_REVENUE');

    await db.$transaction(async (tx) => {
      await postJournal(tx, {
        referenceType: 'FUNDING',
        referenceId: 'f5',
        transactionType: 'WALLET_FUNDING_WITH_FEE',
        currency: 'NGN',
        postings: [
          { ledgerAccountId: cash.id, direction: 'DEBIT', amountMinor: 105n },
          { ledgerAccountId: account.id, direction: 'CREDIT', amountMinor: 100n },
          { ledgerAccountId: fees.id, direction: 'CREDIT', amountMinor: 5n },
        ],
        updates: [{ walletId: wallet.id, deltaMinor: 100n }],
      });
    });

    expect((await db.wallet.findUnique({ where: { id: wallet.id } }))?.balance).toBe(100n);
    expect(await computeWalletBalanceFromLedger(db, wallet.id)).toBe(100n);
  });
});