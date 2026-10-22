import { describe, it, expect } from 'vitest';

import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('applies documented defaults', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      SERVICE_NAME: 'fincore-api',
    });
  });

  it('coerces PORT string to number', () => {
    expect(loadEnv({ PORT: '5000' } as NodeJS.ProcessEnv).PORT).toEqual(5000);
  });

  it('rejects out of range PORT', () => {
    expect(() => loadEnv({ PORT: '500000' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('rejects invalid log level', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'promise' }).LOG_LEVEL).toThrow(/LOG_LEVEL/);
  });
});
