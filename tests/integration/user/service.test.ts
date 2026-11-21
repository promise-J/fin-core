import { execSync } from 'node:child_process';

import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { loadEnv } from '../../../src/config/env';
import { buildPrisma, Db } from '../../../src/infrastructure/database/db';
import { PasswordHasher } from '../../../src/modules/users/password';
import { buildUsersService } from '../../../src/modules/users/service';

let container: StartedPostgreSqlContainer;
let db: Db;

// Fast fake hasher for tests that don't care about Argon2 specifics.
const fakeHasher: PasswordHasher = {
  async hash(plain) {
    return `fake:${plain}`;
  },
  async verify(hash, plain) {
    return hash === `fake:${plain}`;
  },
};

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
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
  );
});

describe('users service', () => {
  it('creates a user and returns a PublicUser without passwordHash', async () => {
    const users = buildUsersService({ db, hasher: fakeHasher });
    const u = await users.createUser({
      email: 'Alice@Example.com',
      password: 'password123',
      fullName: 'Alice',
    });
    expect(u.email).toBe('alice@example.com');
    expect(u).not.toHaveProperty('passwordHash');
    expect(u.status).toBe('ACTIVE');
    expect(u.kycStatus).toBe('NOT_STARTED');
    expect(u.roles).toEqual(['CUSTOMER']);
  });

  it('stores the password hashed, not in plaintext', async () => {
    const users = buildUsersService({ db, hasher: fakeHasher });
    await users.createUser({ email: 'bob@example.com', password: 'secret123' });
    const row = await db.user.findUnique({ where: { email: 'bob@example.com' } });
    expect(row?.passwordHash).toBe('fake:secret123');
    expect(row?.passwordHash).not.toBe('secret123');
  });

  it('rejects a duplicate email with a 409 problem-details error', async () => {
    const users = buildUsersService({ db, hasher: fakeHasher });
    await users.createUser({ email: 'dup@example.com', password: 'p1' });
    await expect(
      users.createUser({ email: 'DUP@example.com', password: 'p2' }),
    ).rejects.toMatchObject({ status: 409, code: 'email_in_use' });
  });

  it('findByEmail is case-insensitive because emails are stored lowercased', async () => {
    const users = buildUsersService({ db, hasher: fakeHasher });
    await users.createUser({ email: 'case@example.com', password: 'p' });
    const found = await users.findByEmail('CASE@Example.COM');
    expect(found?.email).toBe('case@example.com');
  });

  it('findByEmail returns null for unknown emails', async () => {
    const users = buildUsersService({ db, hasher: fakeHasher });
    expect(await users.findByEmail('nobody@example.com')).toBeNull();
  });
});