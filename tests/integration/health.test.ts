import request from 'supertest';
import { expect, describe, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { buildLogger } from '../../src/config/logger.js';

const env = loadEnv({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

const app = createApp({ env, logger: buildLogger(env) });



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
    expect(res.body.requestId).toBeTruthy()
  })
});
