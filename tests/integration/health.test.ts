import request from 'supertest';
import { expect, describe, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { buildLogger } from '../../src/config/logger.js';
import { Db } from '../../src/infrastructure/database/db.js';



const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  REDIS_URL: 'redis://localhost:6379',
} as NodeJS.ProcessEnv);

const logger = buildLogger({ LOG_LEVEL: 'silent', SERVICE_NAME: 'test', NODE_ENV: 'test', REDIS_URL: env.REDIS_URL, DATABASE_URL: env.DATABASE_URL, JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET });
const db = {} as Db;


const app = buildApp({ env, logger, db });

describe('health endpoints', () => {
  it('GET /health/live returns 200', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toEqual(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready honestly returns 503 in Phase 0', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('unknown route returns 404 with requestId', async () => {
    const res = await request(app).get('/unknown');
    expect(res.status).toBe(404);
    expect(res.body.requestId).toBeTruthy();
  });
});
