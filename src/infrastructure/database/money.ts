export class MoneyError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MoneyError';
    }
  }
  
  /**
   * Parse a decimal NGN amount like "20000.00" into kobo (bigint).
   * NGN precision is 2 dp. Reject anything else.
   */
  export function nairaToKobo(input: string): bigint {
    if (typeof input !== 'string') {
      throw new MoneyError(`Amount must be a string, got ${typeof input}`);
    }
    if (!/^\d{1,13}(\.\d{1,2})?$/.test(input)) {
      throw new MoneyError(`Invalid NGN amount: ${input}`);
    }
    const [whole, frac = ''] = input.split('.');
    const fracPadded = (frac + '00').slice(0, 2);
    const kobo = BigInt(whole!) * 100n + BigInt(fracPadded);
    if (kobo <= 0n) throw new MoneyError('Amount must be positive');
    return kobo;
  }
  
  /** Format kobo back to a decimal NGN string. */
  export function koboToNairaString(kobo: bigint): string {
    if (kobo < 0n) throw new MoneyError('Negative amount');
    const whole = kobo / 100n;
    const frac = kobo % 100n;
    return `${whole}.${frac.toString().padStart(2, '0')}`;
  }
  
  /** JSON.stringify replacer for bigint values. */
  export function bigintJsonReplacer(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value;
  }