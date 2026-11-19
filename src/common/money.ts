/**
 * FinCore money utilities.
 *
 * INV-1: All NGN amounts are integer kobo. TypeScript uses bigint.
 * This module is the only place where decimal strings cross into/out of bigint.
 * No floating-point arithmetic is performed anywhere.
 *
 * API representation: decimal strings, e.g. "20000.00" (two fractional digits,
 * no sign, no exponent, no thousands separators, no whitespace).
 *
 * Maximum: 10^15 kobo = 10,000,000,000,000 NGN = 10 trillion NGN (14 digits).
 * This fits within PostgreSQL BIGINT (max ~9.22 * 10^18) with headroom, and
 * is intentionally far above any plausible single-transaction amount.
 */

export const KOBO_PER_NAIRA = 100n;
export const MAX_KOBO = 10n ** 15n;

const DECIMAL_RE = /^(0|[1-9][0-9]*)\.([0-9]{1,2})$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parse a decimal NGN string to bigint kobo.
 * Accepts: "0.00", "1.00", "20000.00", "0.5" (interpreted as 0.50), "123.4" (123.40).
 * Rejects: negative, exponent notation, empty, whitespace, >2 fractional digits,
 *          leading zeros on integer part (except "0.xx"), values above MAX_KOBO.
 */
export function parseNairaToKobo(input: string): bigint {
  if (typeof input !== 'string' || input.length === 0) {
    throw new MoneyError('amount must be a non-empty string');
  }
  const match = DECIMAL_RE.exec(input);
  if (!match) {
    throw new MoneyError(
      `amount must match ^(0|[1-9][0-9]*)\\.([0-9]{1,2})$ (got ${JSON.stringify(input)})`,
    );
  }
  const wholeStr = match[1]!;
  const fracStr = match[2]!;
  const fracKobo = BigInt(fracStr.padEnd(2, '0')); 
  const wholeKobo = BigInt(wholeStr) * KOBO_PER_NAIRA;
  const kobo = wholeKobo + fracKobo;
  if (kobo > MAX_KOBO) {
    throw new MoneyError(`amount exceeds MAX_KOBO (${MAX_KOBO.toString()})`);
  }
  return kobo;
}

/**
 * Serialize bigint kobo to a canonical decimal NGN string, e.g. 2000000n -> "20000.00".
 * Always emits exactly 2 fractional digits. Never uses scientific notation.
 */
export function formatKoboAsNaira(kobo: bigint): string {
  if (kobo < 0n) {
    throw new MoneyError('kobo must be non-negative');
  }
  if (kobo > MAX_KOBO) {
    throw new MoneyError('kobo exceeds MAX_KOBO');
  }
  const whole = kobo / KOBO_PER_NAIRA;
  const frac = kobo % KOBO_PER_NAIRA;
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Safe conversion for Prisma: bigint -> string for Prisma's `BigInt` columns.
 * Prisma's BigInt columns accept JS bigint directly, so this is a thin guard.
 */
export function assertKobo(kobo: bigint): bigint {
  if (typeof kobo !== 'bigint') {
    throw new MoneyError(`expected bigint kobo, got ${typeof kobo}`);
  }
  if (kobo < 0n || kobo > MAX_KOBO) {
    throw new MoneyError('kobo out of range');
  }
  return kobo;
}