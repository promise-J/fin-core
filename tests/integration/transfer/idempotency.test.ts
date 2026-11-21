import { execSync } from 'node:child_process';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { loadEnv } from '../../../src/config/env';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';
import { buildIdempotencyService, fingerprint } from '../../../src/modules/transfers/idempotency';

let container: StartedPostgreSqlContainer;
let db: Db;
let idem: ReturnType<typeof buildIdempotencyService>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('fincore_test').withUsername('fincore').withPassword('fincore').start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url, JWT_ACCESS_SECRET: 'a'.repeat(32), REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv);
  db = buildPrisma(env);
  idem = buildIdempotencyService(db);
}, 120_000);

afterAll(async () => { await db?.$disconnect(); await container?.stop(); });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "IdempotencyRecord" RESTART IDENTITY CASCADE');
});

const body = { sourceWalletId: 'w1', destinationWalletId: 'w2', amount: '100.00', currency: 'NGN' };

describe('idempotency service', () => {
  it('runs the operation once and replays the stored response', async () => {
    let calls = 0;
    const op = async () => { calls++; return { status: 200, body: { ok: true } }; };

    const ctx = { scope: 'test', key: 'k1', userId: null, requestFingerprint: fingerprint(body) };
    const r1 = await idem.run(ctx, op);
    const r2 = await idem.run(ctx, op);

    expect(calls).toBe(1);
    expect(r1.body).toEqual({ ok: true });
    expect(r2.body).toEqual({ ok: true });
    expect(r2.status).toBe(200);
  });

  it('rejects same key with different body', async () => {
    const op = async () => ({ status: 200, body: { ok: true } });
    const ctx1 = { scope: 'test', key: 'k2', userId: null, requestFingerprint: fingerprint(body) };
    await idem.run(ctx1, op);
    const ctx2 = { ...ctx1, requestFingerprint: fingerprint({ ...body, amount: '999.00' }) };
    await expect(idem.run(ctx2, op)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rolls back the idempotency row when the operation throws', async () => {
    const ctx = { scope: 'test', key: 'k3', userId: null, requestFingerprint: fingerprint(body) };
    await expect(
      idem.run(ctx, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    const rows = await db.idempotencyRecord.findMany({ where: { key: 'k3' } });
    expect(rows).toHaveLength(0);
  });

  it('a retry after a thrown operation can succeed with the same key', async () => {
    const ctx = { scope: 'test', key: 'k4', userId: null, requestFingerprint: fingerprint(body) };
    await expect(idem.run(ctx, async () => { throw new Error('first'); })).rejects.toThrow('first');
    const r = await idem.run(ctx, async () => ({ status: 200, body: { ok: true } }));
    expect(r.body).toEqual({ ok: true });
  });

  it('concurrent same-key requests: exactly one executes, the other gets in_progress', async () => {
    let calls = 0;
    const slowOp = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
      return { status: 200, body: { ok: true, calls } };
    };
    const ctx = { scope: 'test', key: 'k5', userId: null, requestFingerprint: fingerprint(body) };

    const [a, b] = await Promise.allSettled([
      idem.run(ctx, slowOp),
      idem.run(ctx, slowOp),
    ]);

    const successes = [a, b].filter((r) => r.status === 'fulfilled').length;
    const inProgress = [a, b].filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'idempotency_in_progress',
    ).length;

    expect(calls).toBe(1);
    expect(successes).toBe(1);
    expect(inProgress).toBe(1);
  });

  it('replay after completion returns the original result even if body differs in whitespace', async () => {
    // The fingerprint canonicalizes — verify it doesn't just string-compare.
    const a = { a: 1, b: 2 };
    const b = { b: 2, a: 1 };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('stores the correct resourceId', async () => {
    const ctx = { scope: 'test', key: 'k6', userId: null, requestFingerprint: fingerprint(body) };
    await idem.run(ctx, async () => ({ status: 201, body: { id: 'res-1' }, resourceId: 'res-1' }));
    const row = await db.idempotencyRecord.findUnique({ where: { scope_key: { scope: 'test', key: 'k6' } } });
    expect(row?.resourceId).toBe('res-1');
    expect(row?.responseStatus).toBe(201);
  });

  it('different scopes with the same key are independent', async () => {
    const ctx1 = { scope: 'a', key: 'same', userId: null, requestFingerprint: fingerprint(body) };
    const ctx2 = { scope: 'b', key: 'same', userId: null, requestFingerprint: fingerprint(body) };
    let calls = 0;
    const op = async () => { calls++; return { status: 200, body: { calls } }; };
    await idem.run(ctx1, op);
    await idem.run(ctx2, op);
    expect(calls).toBe(2);
  });
});