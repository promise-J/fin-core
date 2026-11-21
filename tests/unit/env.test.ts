import { describe, it, expect } from 'vitest';

import { loadEnv } from '../../src/config/env';

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

    it('coerces PORT string to number', ()=>{
        expect(loadEnv({PORT: "5000"} as NodeJS.ProcessEnv).PORT).toEqual(5000)
    })

    it('rejects out of range PORT', ()=>{
        expect(()=> loadEnv({PORT: '500000'} as NodeJS.ProcessEnv)).toThrow(/PORT/)
    })

    it('rejects invalid log level', ()=>{
        expect(()=> loadEnv({LOG_LEVEL: 'promise'}).LOG_LEVEL).toThrow(/LOG_LEVEL/)
    })

    it('requires DATABASE_URL in production', () => {
        expect(() => loadEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
      });
      
      it('allows missing DATABASE_URL in development', () => {
        const env = loadEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
        expect(env.DATABASE_URL).toBeUndefined();
      });
})
