import { describe, it, expect } from 'vitest';

import { koboToNairaString, MoneyError, nairaToKobo } from '../../src/infrastructure/database/money.js';


describe('nairaToKobo', () => {
  it('parses "20000.00" as 2_000_000n', () => {
    expect(nairaToKobo('20000.00')).toBe(2_000_000n);
  });
  it('parses "0.01" as 1n', () => {
    expect(nairaToKobo('0.01')).toBe(1n);
  });
  it('parses integer "5" as 500n', () => {
    expect(nairaToKobo('5')).toBe(500n);
  });
  it('rejects more than 2 decimal places', () => {
    expect(() => nairaToKobo('1.234')).toThrow(MoneyError);
  });
  it('rejects negative', () => {
    expect(() => nairaToKobo('-1.00')).toThrow(MoneyError);
  });
  it('rejects zero', () => {
    expect(() => nairaToKobo('0.00')).toThrow(MoneyError);
  });
  it('rejects non-numeric', () => {
    expect(() => nairaToKobo('abc')).toThrow(MoneyError);
  });
  it('rejects non-string input', () => {
    expect(() => nairaToKobo(1 as unknown as string)).toThrow(MoneyError);
  });
});

describe('koboToNairaString', () => {
  it('formats 2_000_000n as "20000.00"', () => {
    expect(koboToNairaString(2_000_000n)).toBe('20000.00');
  });
  it('formats 1n as "0.01"', () => {
    expect(koboToNairaString(1n)).toBe('0.01');
  });
  it('formats 500n as "5.00"', () => {
    expect(koboToNairaString(500n)).toBe('5.00');
  });
  it('rejects negative', () => {
    expect(() => koboToNairaString(-1n)).toThrow(MoneyError);
  });
});