import { randomBytes, createHash } from 'node:crypto';

export function generateVerificationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashVerificationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function buildVerificationEmail(baseUrl: string, rawToken: string) {
  const url = `${baseUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
  return {
    subject: 'Verify your FinCore email',
    bodyText:
      `Welcome to FinCore.\n\n` +
      `Click the link below to verify your email address. ` +
      `The link expires in 24 hours.\n\n${url}\n\n` +
      `If you didn't create this account, you can ignore this email.`,
  };
}