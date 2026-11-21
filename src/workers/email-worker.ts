import { loadEnv } from '../config/env';
import { buildLogger } from '../config/logger';
import { buildPrisma } from '../infrastructure/database/db';
import { buildFileMailSender } from '../infrastructure/mail/console-mail-sender';

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2_000;
const CLAIM_BATCH = 10;
const CLAIM_TIMEOUT_MS = 60_000;

async function main() {
  const env = loadEnv();
  const logger = buildLogger({ LOG_LEVEL: env.LOG_LEVEL, SERVICE_NAME: 'fincore-email-worker', NODE_ENV: env.NODE_ENV, REDIS_URL: env.REDIS_URL, DATABASE_URL: env.DATABASE_URL, JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET });
  const db = buildPrisma(env);
  const mailer = buildFileMailSender(env.MAIL_OUTBOX_PATH);
  const workerId = `email-worker-${process.pid}`;

  let shuttingDown = false;
  process.on('SIGTERM', () => { shuttingDown = true; });
  process.on('SIGINT', () => { shuttingDown = true; });

  logger.info({ workerId }, 'email worker started');

  while (!shuttingDown) {
    try {
      const claimed = await claimBatch(workerId);
      if (claimed.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      for (const row of claimed) {
        try {
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
          logger.info({ id: row.id, to: row.toAddress }, 'email sent');
        } catch (err) {
          const attempts = row.attempts + 1;
          const dead = attempts >= MAX_ATTEMPTS;
          await db.emailOutbox.update({
            where: { id: row.id },
            data: {
              status: dead ? 'DEAD_LETTERED' : 'PENDING',
              attempts,
              lastError: String(err),
              claimedBy: null,
              claimedAt: null,
              nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
            },
          });
          logger.warn({ id: row.id, attempts, dead, err: String(err) }, 'email send failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'email worker loop error');
      await sleep(POLL_INTERVAL_MS);
    }
  }

  logger.info('email worker shutting down');
  await db.$disconnect();
  process.exit(0);

  async function claimBatch(workerId: string) {
    return db.$transaction(async (tx) => {
      const rows: Array<{
        id: string;
        toAddress: string;
        subject: string;
        bodyText: string;
        bodyHtml: string | null;
        attempts: number;
      }> = await tx.$queryRaw`
        SELECT id, "toAddress", subject, "bodyText", "bodyHtml", attempts
        FROM "EmailOutbox"
        WHERE status = 'PENDING'
          AND "nextAttemptAt" <= now()
          AND (
            "claimedBy" IS NULL
            OR "claimedAt" < now() - ${CLAIM_TIMEOUT_MS} * interval '1 millisecond'
          )
        ORDER BY "createdAt"
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      await tx.emailOutbox.updateMany({
        where: { id: { in: ids } },
        data: { status: 'SENDING', claimedBy: workerId, claimedAt: new Date() },
      });
      return rows;
    });
  }

  function backoffMs(attempts: number) {
    const base = Math.min(60_000, 1000 * 2 ** attempts);
    return base + Math.floor(Math.random() * 500);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('email worker fatal', err);
  process.exit(1);
});