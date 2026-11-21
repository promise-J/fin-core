import { randomUUID } from 'node:crypto';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response, NextFunction, json } from 'express';
import helmet from 'helmet';
import {pinoHttp} from 'pino-http';

// eslint-disable-next-line import/no-unresolved
import { toProblemDetails } from './common/errors.js';
import { Env } from './config/env.js';
import {AppLogger} from './config/logger.js';
import { Db } from './infrastructure/database/db.js';
import { buildAuthRouter } from './modules/auth/routes.js';

export interface AppDeps {
  env: Env;
  logger: AppLogger;
  db: Db,
  isReady?: () => Promise<{ ready: boolean; reason?: string }>;
}

export function buildApp(deps: AppDeps) {
  const { env, logger, db } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(json({ limit: env.BODY_LIMIT_BYTES }));
  app.use(cookieParser());


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

  app.use((req, _res, next) => {
    req.requestId = (req as {id: string}).id;
    next();
  });

  // Health endpoints.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    if (!deps.isReady) {
      return res.status(503).json({ status: 'not_ready' });
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


  app.use('/api/v1/auth', buildAuthRouter({ db, env }));

  // 404 for everything else.
  app.use((req, res) => {
    res.status(404).json({
      type: 'about:blank',
      status: 404,
      title: 'Not Found',
      instance: req.originalUrl,
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
    });
  });

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