import { describe, it, expect } from 'vitest';

import { loadEnv } from '../../src/config/env';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../../src/modules/auth/tokens';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  REDIS_URL: 'redis://localhost:6379',
} as NodeJS.ProcessEnv);

describe('refresh token', () => {
  it('generates a raw token and its hash', () => {
    const { raw, hash } = generateRefreshToken();
    expect(raw.length).toBeGreaterThan(40);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it('hash of the same raw token is stable', () => {
    const { raw } = generateRefreshToken();
    expect(hashRefreshToken(raw)).toBe(hashRefreshToken(raw));
  });

  it('different raw tokens have different hashes', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('access token', () => {
  it('signs and verifies', () => {
    const issued = signAccessToken(
      { sub: 'user_1', sid: 'sess_1', roles: ['CUSTOMER'] },
      env,
    );
    const decoded = verifyAccessToken(issued.token, env);
    expect(decoded.sub).toBe('user_1');
    expect(decoded.sid).toBe('sess_1');
    expect(decoded.roles).toEqual(['CUSTOMER']);
  });

  it('rejects a token signed with a different secret', () => {
    const wrongEnv = { ...env, JWT_ACCESS_SECRET: 'b'.repeat(32) };
    const issued = signAccessToken(
      { sub: 'user_1', sid: 'sess_1', roles: ['CUSTOMER'] },
      wrongEnv,
    );
    expect(() => verifyAccessToken(issued.token, env)).toThrow(/invalid/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyAccessToken('not.a.jwt', env)).toThrow(/invalid/i);
  });
});