import { execSync } from 'node:child_process';

import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { loadEnv } from '../../../src/config/env';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';
import { buildSessionService } from '../../../src/modules/auth/session-service';
import { hashRefreshToken } from '../../../src/modules/auth/tokens';

let container: StartedPostgreSqlContainer;
let db: Db;
let env: ReturnType<typeof loadEnv>;
let sessions: ReturnType<typeof buildSessionService>;

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

  env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
  } as NodeJS.ProcessEnv);

  db = buildPrisma(env);
  sessions = buildSessionService({ db, env });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "Session", "User" RESTART IDENTITY CASCADE',
  );
});

async function makeUser(email = 'sess@example.com') {
  return db.user.create({
    data: {
      email,
      passwordHash: 'fake',
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      roles: ['CUSTOMER'],
    },
  });
}

describe('session service', () => {
  it('startSession creates a session and returns a refresh + access token', async () => {
    const user = await makeUser();
    const out = await sessions.startSession(user.id, user.roles, {});
    expect(out.refreshToken).toBeTruthy();
    expect(out.accessToken).toBeTruthy();
    expect(out.sessionId).toBeTruthy();

    const row = await db.session.findUnique({ where: { id: out.sessionId } });
    expect(row?.refreshTokenHash).toBe(hashRefreshToken(out.refreshToken));
    expect(row?.refreshTokenHash).not.toBe(out.refreshToken);
  });

  it('rotate returns a new refresh token and revokes the old one', async () => {
    const user = await makeUser();
    const first = await sessions.startSession(user.id, user.roles, {});
    const second = await sessions.rotate(first.refreshToken, {});

    const oldRow = await db.session.findUnique({
      where: { id: first.sessionId },
    });
    expect(oldRow?.revokedAt).toBeTruthy();
    expect(oldRow?.replacedById).toBe(second.sessionId);
    expect(oldRow?.familyId).toBe(
      (await db.session.findUnique({ where: { id: second.sessionId } }))?.familyId,
    );
  });

  it('rotating with a revoked token revokes the whole family (reuse detection)', async () => {
    const user = await makeUser();
    const first = await sessions.startSession(user.id, user.roles, {});
    const second = await sessions.rotate(first.refreshToken, {});

    // Attacker replays the old token.
    await expect(sessions.rotate(first.refreshToken, {})).rejects.toMatchObject({
      status: 401,
      code: 'refresh_token_reused',
    });

    // The family — including the legitimate successor — is now revoked.
    const family = await db.session.findMany({
      where: {
        id: { in: [first.sessionId, second.sessionId] },
      },
    });
    expect(family.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('rotating an expired session rejects and marks it revoked', async () => {
    const user = await makeUser();
    const first = await sessions.startSession(user.id, user.roles, {});
    // Force expiry in the past.
    await db.session.update({
      where: { id: first.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(sessions.rotate(first.refreshToken, {})).rejects.toMatchObject({
      status: 401,
      code: 'refresh_token_expired',
    });
  });

  it('rotate rejects for an inactive user', async () => {
    const user = await makeUser();
    const first = await sessions.startSession(user.id, user.roles, {});
    await db.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    await expect(sessions.rotate(first.refreshToken, {})).rejects.toMatchObject({
      status: 403,
      code: 'account_inactive',
    });
  });

  it('revokeByToken is idempotent', async () => {
    const user = await makeUser();
    const s = await sessions.startSession(user.id, user.roles, {});
    await sessions.revokeByToken(s.refreshToken);
    await sessions.revokeByToken(s.refreshToken); // no throw
    const row = await db.session.findUnique({ where: { id: s.sessionId } });
    expect(row?.revokedAt).toBeTruthy();
  });

  it('revokeAllForUser revokes every active session for that user', async () => {
    const user = await makeUser();
    const s1 = await sessions.startSession(user.id, user.roles, {});
    const s2 = await sessions.startSession(user.id, user.roles, {});
    await sessions.revokeAllForUser(user.id);
    const rows = await db.session.findMany({
      where: { id: { in: [s1.sessionId, s2.sessionId] } },
    });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('rotate refuses an unknown refresh token', async () => {
    await expect(sessions.rotate('nonsense', {})).rejects.toMatchObject({
      status: 401,
      code: 'invalid_refresh_token',
    });
  });
});