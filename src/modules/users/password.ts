import argon2 from 'argon2';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const argonPasswordHasher: PasswordHasher = {
  async hash(plain) {
    return argon2.hash(plain, ARGON_OPTIONS);
  },
  async verify(hash, plain) {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // Malformed hash in the DB — treat as a failed verification.
      // Do not let it throw into the login flow.
      return false;
    }
  },
};