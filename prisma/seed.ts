import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const INTERNAL_ACCOUNTS = [
  { code: 'PLATFORM_CASH_NGN', type: 'PLATFORM_CASH' },
  { code: 'PAYMENT_CLEARING_NGN', type: 'PAYMENT_CLEARING' },
  { code: 'FEE_REVENUE_NGN', type: 'FEE_REVENUE' },
  { code: 'REFUND_CLEARING_NGN', type: 'REFUND_CLEARING' },
  { code: 'REVERSAL_CLEARING_NGN', type: 'REVERSAL_CLEARING' },
  { code: 'SUSPENSE_NGN', type: 'SUSPENSE' },
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const adapter = new PrismaPg({ connectionString: url });
  const db = new PrismaClient({ adapter });

  for (const { code, type } of INTERNAL_ACCOUNTS) {
    await db.ledgerAccount.upsert({
      where: { internalCode: code },
      update: {},
      create: { internalCode: code, type, currency: 'NGN' },
    });
    // eslint-disable-next-line no-console
    console.log(`internal account ${code} ready`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });