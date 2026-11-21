import { Request, Response, NextFunction } from 'express';

import { ProblemDetailsError } from '../../common/errors';
import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';

import { verifyAccessToken } from './tokens';

export interface RequireAuthDeps {
  env: Env;
  db: Db;
  checkSessionRevoked?: boolean;
}

export function requireAuth({
  env,
  db,
  checkSessionRevoked = false,
}: RequireAuthDeps) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        throw new ProblemDetailsError(
          401,
          'missing_authorization',
          'Authorization header is required.',
        );
      }
      const token = header.slice('Bearer '.length).trim();
      const payload = verifyAccessToken(token, env);

      if (checkSessionRevoked) {
        const session = await db.session.findUnique({
          where: { id: payload.sid },
        });
        if (!session || session.revokedAt) {
          throw new ProblemDetailsError(
            401,
            'session_revoked',
            'Session has been revoked.',
          );
        }
        if (session.expiresAt.getTime() <= Date.now()) {
          throw new ProblemDetailsError(
            401,
            'session_expired',
            'Session has expired.',
          );
        }
      }

      req.user = {
        id: payload.sub,
        sessionId: payload.sid,
        roles: payload.roles,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...allowed: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(
        new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.'),
      );
    }
    const has = req.user.roles.some((r) => allowed.includes(r));
    if (!has) {
      return next(
        new ProblemDetailsError(403, 'forbidden', 'Insufficient privileges.'),
      );
    }
    next();
  };
}