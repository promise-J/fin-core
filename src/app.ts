import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';

import type { Env } from './config/env.js';
import type { buildLogger } from './config/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';

export interface AppDeps {
  env: Env;
  logger: ReturnType<typeof buildLogger>;
  readinessChecks?: Array<{ name: string; check: () => Promise<void> }>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(pinoHttp({ logger: deps.logger, customProps: (req) => ({ requestId: req.requestId }) }));
  // eslint-disable-next-line import/no-named-as-default-member
  app.use(express.json({ limit: '1mb' }));

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    const checks = deps.readinessChecks ?? [];
    if (checks.length === 0) {
      res.status(503).json({
        status: 'not_ready',
        reason: 'no readiness checks configured yet (Phase 0)',
      });
      return;
    }
    try {
      for (const c of checks) await c.check();
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.use((req, res, _next) => {
    res.status(404).json({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      instance: req.originalUrl,
      requestId: req.requestId,
    });
  });

  app.use(errorHandler);
  return app;
}
