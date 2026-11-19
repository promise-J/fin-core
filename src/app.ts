import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import {pinoHttp} from 'pino-http';

// eslint-disable-next-line import/no-unresolved
import { toProblemDetails } from './common/errors.js';
import { Env } from './config/env.js';
import {AppLogger} from './config/logger.js';

export interface AppDeps {
  env: Env;
  logger: AppLogger;
  /** Provided by later sub-phases. Optional so 2.1 can run alone. */
  isReady?: () => Promise<{ ready: boolean; reason?: string }>;
}

export function buildApp(deps: AppDeps) {
  const { env, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: env.BODY_LIMIT_BYTES }));

  // Request ID + structured HTTP logging.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) =>
        (req.headers['x-request-id'] as string) ?? randomUUID(),
      customProps: (req) => ({ correlationId: (req as { id?: string | number }).id }),
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // Health endpoints.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    if (!deps.isReady) {
      return res.status(200).json({ status: 'ready' });
    }
    try {
      const result = await deps.isReady();
      if (!result.ready) {
        return res
          .status(503)
          .json({ status: 'not_ready', reason: result.reason });
      }
      return res.status(200).json({ status: 'ready' });
    } catch (err) {
      logger.error({ err }, 'readiness probe failed');
      return res.status(503).json({ status: 'not_ready' });
    }
  });

  // 404 for everything else.
  app.use((_req, res) => {
    res.status(404).json({ type: 'about:blank', status: 404, title: 'Not Found' });
  });

  // Central error handler. Must have 4 params for Express to detect it.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const problem = toProblemDetails(err);
    if (problem.status >= 500) {
      req.log.error({ err }, 'unhandled request error');
    } else {
      req.log.warn({ err: problem }, 'request rejected');
    }
    res.status(problem.status).json(problem);
  });

  return app;
}