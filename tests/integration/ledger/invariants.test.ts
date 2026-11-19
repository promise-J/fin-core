import { execSync } from 'node:child_process';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';


let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('fincore_test')
    .withUsername('fincore')
    .withPassword('fincore')
    .start();

  const url = container.getConnectionUri();

  execSync(`npx prisma migrate deploy`, {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const adapter = new PrismaPg({ connectionString: url });
  prisma = new PrismaClient({ adapter });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LedgerPosting",
      "JournalEntry",
      "Transfer",
      "Payment",
      "Refund",
      "IdempotencyRecord",
      "LedgerAccount",
      "Wallet",
      "Session",
      "AuditLog",
      "KycReview",
      "User"
    RESTART IDENTITY CASCADE
  `);
});

async function makeUser(email = 'test@example.com') {
  return prisma.user.create({
    data: {
      email,
      passwordHash: 'argon2id-placeholder',
      fullName: 'Test User',
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      roles: ['CUSTOMER'],
    },
  });
}

async function makeWalletWithAccount(ownerId: string) {
  const wallet = await prisma.wallet.create({
    data: { ownerId, currency: 'NGN', status: 'ACTIVE', balance: 0n },
  });
  const account = await prisma.ledgerAccount.create({
    data: { type: 'CUSTOMER_WALLET', currency: 'NGN', walletId: wallet.id },
  });
  return { wallet, account };
}

async function makeInternalAccount(
  code: string,
  type: 'PLATFORM_CASH' | 'FEE_REVENUE' | 'PAYMENT_CLEARING' = 'PLATFORM_CASH',
) {
  return prisma.ledgerAccount.create({
    data: { type, currency: 'NGN', internalCode: code },
  });
}

describe('Ledger invariants enforced by the database', () => {
  it('CHECK: rejects a zero-amount posting', async () => {
    const user = await makeUser();
    const { wallet, account } = await makeWalletWithAccount(user.id);
    const entry = await prisma.journalEntry.create({
      data: {
        referenceType: 'TEST',
        referenceId: 'r1',
        transactionType: 'TEST',
        currency: 'NGN',
      },
    });
    await expect(
      prisma.ledgerPosting.create({
        data: {
          journalEntryId: entry.id,
          ledgerAccountId: account.id,
          direction: 'DEBIT',
          amountMinor: 0n,
          currency: 'NGN',
        },
      }),
    ).rejects.toThrow(/amount_positive|check constraint/i);
    expect(
      (await prisma.wallet.findUnique({ where: { id: wallet.id } }))?.balance,
    ).toBe(0n);
  });

  it('TRIGGER: rejects an unbalanced journal at COMMIT', async () => {
    const user = await makeUser('u2@example.com');
    const { account } = await makeWalletWithAccount(user.id);
    await makeInternalAccount('PLATFORM_CASH_NGN');

    await expect(
      prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            referenceType: 'TEST',
            referenceId: 'r2',
            transactionType: 'TEST',
            currency: 'NGN',
          },
        });
        await tx.ledgerPosting.create({
          data: {
            journalEntryId: entry.id,
            ledgerAccountId: account.id,
            direction: 'CREDIT',
            amountMinor: 100n,
            currency: 'NGN',
          },
        });
        // Deliberately forget the matching DEBIT.
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it('TRIGGER: rejects UPDATE of a LedgerPosting row', async () => {
    const user = await makeUser('u3@example.com');
    const { wallet, account } = await makeWalletWithAccount(user.id);
    const internal = await makeInternalAccount('PLATFORM_CASH_NGN_2');

    const entry = await prisma.journalEntry.create({
      data: {
        referenceType: 'TEST',
        referenceId: 'r3',
        transactionType: 'TEST',
        currency: 'NGN',
      },
    });

    // Set up a balanced journal AND update the wallet projection,
    // otherwise Trigger 4 aborts the setup before we ever get to
    // the UPDATE we want to test.
    await prisma.$transaction(async (tx) => {
      await tx.ledgerPosting.create({
        data: {
          journalEntryId: entry.id,
          ledgerAccountId: account.id,
          direction: 'CREDIT',
          amountMinor: 100n,
          currency: 'NGN',
        },
      });
      await tx.ledgerPosting.create({
        data: {
          journalEntryId: entry.id,
          ledgerAccountId: internal.id,
          direction: 'DEBIT',
          amountMinor: 100n,
          currency: 'NGN',
        },
      });
      await tx.$executeRawUnsafe(
        `UPDATE "Wallet" SET balance = balance + $1 WHERE id = $2`,
        100n,
        wallet.id,
      );
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "LedgerPosting" SET "amountMinor" = 999 WHERE "journalEntryId" = $1`,
        entry.id,
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('TRIGGER: rejects DELETE of a LedgerPosting row', async () => {
    const user = await makeUser('u4@example.com');
    const { wallet, account } = await makeWalletWithAccount(user.id);
    const internal = await makeInternalAccount('PLATFORM_CASH_NGN_3');

    const entry = await prisma.journalEntry.create({
      data: {
        referenceType: 'TEST',
        referenceId: 'r4',
        transactionType: 'TEST',
        currency: 'NGN',
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.ledgerPosting.create({
        data: {
          journalEntryId: entry.id,
          ledgerAccountId: account.id,
          direction: 'CREDIT',
          amountMinor: 100n,
          currency: 'NGN',
        },
      });
      await tx.ledgerPosting.create({
        data: {
          journalEntryId: entry.id,
          ledgerAccountId: internal.id,
          direction: 'DEBIT',
          amountMinor: 100n,
          currency: 'NGN',
        },
      });
      await tx.$executeRawUnsafe(
        `UPDATE "Wallet" SET balance = balance + $1 WHERE id = $2`,
        100n,
        wallet.id,
      );
    });

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "LedgerPosting" WHERE "journalEntryId" = $1`,
        entry.id,
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('TRIGGER: allows JournalEntry POSTED -> REVERSED, rejects other UPDATEs', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        referenceType: 'TEST',
        referenceId: 'r5',
        transactionType: 'TEST',
        currency: 'NGN',
      },
    });
    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { status: 'REVERSED' },
      }),
    ).resolves.toBeTruthy();

    const entry2 = await prisma.journalEntry.create({
      data: {
        referenceType: 'TEST',
        referenceId: 'r6',
        transactionType: 'TEST',
        currency: 'NGN',
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "JournalEntry" SET "referenceId" = 'hacked' WHERE id = $1`,
        entry2.id,
      ),
    ).rejects.toThrow(/Illegal JournalEntry mutation/i);
  });

  it('TRIGGER: rejects wallet balance drift at COMMIT', async () => {
    const user = await makeUser('u6@example.com');
    const { account } = await makeWalletWithAccount(user.id);
    const internal = await makeInternalAccount('PLATFORM_CASH_NGN_6');

    await expect(
      prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            referenceType: 'TEST',
            referenceId: 'r7',
            transactionType: 'TEST',
            currency: 'NGN',
          },
        });
        await tx.ledgerPosting.create({
          data: {
            journalEntryId: entry.id,
            ledgerAccountId: account.id,
            direction: 'CREDIT',
            amountMinor: 500n,
            currency: 'NGN',
          },
        });
        await tx.ledgerPosting.create({
          data: {
            journalEntryId: entry.id,
            ledgerAccountId: internal.id,
            direction: 'DEBIT',
            amountMinor: 500n,
            currency: 'NGN',
          },
        });
        // Forgot: wallet.update(...) — on purpose, to prove the trigger catches it.
      }),
    ).rejects.toThrow(/balance drift/i);
  });

  it('CONSTRAINT: rejects deleting a User that owns a Wallet (Restrict)', async () => {
    const user = await makeUser('u7@example.com');
    await makeWalletWithAccount(user.id);
    await expect(
      prisma.user.delete({ where: { id: user.id } }),
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});