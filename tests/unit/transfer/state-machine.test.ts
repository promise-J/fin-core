import { TransferStatus } from '@prisma/client';
import { describe, it, expect } from 'vitest';

import { canTransition, assertTransition } from '../../../src/modules/transfers/state-machine';

describe('transfer state machine', () => {
  const LEGAL: Array<[TransferStatus, TransferStatus]> = [
    ['PENDING', 'PROCESSING'],
    ['PENDING', 'CANCELLED'],
    ['PENDING', 'FAILED'],
    ['PROCESSING', 'COMPLETED'],
    ['PROCESSING', 'FAILED'],
    ['COMPLETED', 'REVERSED'],
  ];

  it.each(LEGAL)('%s → %s is legal', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const ALL: TransferStatus[] = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED'];

  it('rejects everything not in the legal table', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const isLegal = LEGAL.some(([f, t]) => f === from && t === to);
        if (!isLegal) {
          expect(canTransition(from, to)).toBe(false);
          expect(() => assertTransition(from, to)).toThrow(/invalid_transition/);
        }
      }
    }
  });

  it('explicitly forbids COMPLETED → FAILED', () => {
    expect(canTransition('COMPLETED', 'FAILED')).toBe(false);
  });

  it('explicitly forbids FAILED → COMPLETED', () => {
    expect(canTransition('FAILED', 'COMPLETED')).toBe(false);
  });

  it('explicitly forbids PROCESSING → PENDING (no undo)', () => {
    expect(canTransition('PROCESSING', 'PENDING')).toBe(false);
  });
});