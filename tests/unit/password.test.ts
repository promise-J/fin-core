import { describe, it, expect } from 'vitest';

import { argonPasswordHasher } from '../../src/modules/users/password';

describe('argonPasswordHasher', () => {
  it('produces a hash that verifies against the original', async () => {
    const hash = await argonPasswordHasher.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await argonPasswordHasher.verify(hash, 'correct horse battery staple')).toBe(true);
  });

  it('fails verification against a wrong password', async () => {
    const hash = await argonPasswordHasher.hash('hello');
    expect(await argonPasswordHasher.verify(hash, 'goodbye')).toBe(false);
  });

  it('produces a different hash for the same input each time (salted)', async () => {
    const a = await argonPasswordHasher.hash('same');
    const b = await argonPasswordHasher.hash('same');
    expect(a).not.toBe(b);
    expect(await argonPasswordHasher.verify(a, 'same')).toBe(true);
    expect(await argonPasswordHasher.verify(b, 'same')).toBe(true);
  });

  it('returns false for a malformed stored hash rather than throwing', async () => {
    expect(await argonPasswordHasher.verify('not-a-hash', 'x')).toBe(false);
  });
});