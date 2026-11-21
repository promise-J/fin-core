import { Request, Response, NextFunction } from 'express';

import { ProblemDetailsError } from '../../common/errors.js';
import { Env } from '../../config/env.js';
import { Db } from '../../infrastructure/database/db.js';
import { PasswordHasher } from '../users/password.js';
import { UsersService, toPublicUser } from '../users/service.js';

import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies.js'
import {
  LoginBody,
  RegisterBody,
  parseOrThrow,
} from './schema.js';
import { SessionService } from './session-service.js';

export interface AuthControllerDeps {
  db: Db;
  env: Env;
  users: UsersService;
  sessions: SessionService;
  hasher: PasswordHasher;
}

/** Standard response body for a successful auth handshake. */
function authResponse(result: Awaited<ReturnType<SessionService['startSession']>>) {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
    user: { id: result.userId, roles: result.roles },
  };
}

export function buildAuthController(deps: AuthControllerDeps) {
  const { db, users, env, sessions, hasher } = deps;

  return {
    async register(req: Request, res: Response, next: NextFunction) {
      try {
        const input = parseOrThrow(RegisterBody, req.body);
        // createUser throws 409 email_in_use on duplicate.
        const user = await users.createUser({
          email: input.email,
          password: input.password,
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
        });

        const userAgent = req.headers['user-agent'];

        const auth = await sessions.startSession(user.id, user.roles, {
          ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
          ...(userAgent !== undefined ? { userAgent } : {}),
        });
        
        setRefreshCookie(res, auth.refreshToken, auth.refreshTokenExpiresAt, env);

        return res.status(201).json(authResponse(auth));
      } catch (err) {
        next(err);
        return
      }
    },

    async login(req: Request, res: Response, next: NextFunction) {
      try {
        const input = parseOrThrow(LoginBody, req.body);
        const user = await users.findByEmail(input.email);

        const hash = user?.passwordHash ?? ""
        const ok = await hasher.verify(hash, input.password);
        if (!user || !ok) {
          throw new ProblemDetailsError(
            401,
            'invalid_credentials',
            'Email or password is incorrect.',
          );
        }

        if (user.status !== 'ACTIVE') {
          throw new ProblemDetailsError(
            403,
            'account_inactive',
            'Account is not active.',
          );
        }

        await db.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        const userAgent = req.headers['user-agent'];

        const auth = await sessions.startSession(user.id, user.roles, {
          ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
          ...(userAgent !== undefined ? { userAgent } : {}),
        });
        setRefreshCookie(res, auth.refreshToken, auth.refreshTokenExpiresAt, env);
        return res.status(200).json(authResponse(auth));
      } catch (err) {
        next(err);
        return
      }
    },

    async refresh(req: Request, res: Response, next: NextFunction) {
      try {
        const raw = readRefreshCookie(req.cookies);

        if (!raw) {
          throw new ProblemDetailsError(
            401, 'missing_refresh_token', 'Refresh token cookie is required.',
          );
        }

        const userAgent = req.headers['user-agent']
        const auth = await sessions.rotate(raw, {
          ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
          ...(userAgent !== undefined ? { userAgent } : {}),
        });
    
        setRefreshCookie(res, auth.refreshToken, auth.refreshTokenExpiresAt, env);
        return res.status(200).json(authResponse(auth));
      } catch (err) {
        next(err);
        return
      }
    },

    async logout(req: Request, res: Response, next: NextFunction) {
      try {
        const raw = readRefreshCookie(req.cookies);
        if (raw) {
          await sessions.revokeByToken(raw);
        }
        clearRefreshCookie(res, env);
        return res.status(204).send();
      } catch (err) {
        next(err);
        return
      }
    },

    async logoutAll(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) {
          throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        }
        await sessions.revokeAllForUser(req.user.id);
        return res.status(204).send();
      } catch (err) {
        next(err);
        return
      }
    },

    async me(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) {
          throw new ProblemDetailsError(401, 'not_authenticated', 'Authentication required.');
        }
        const user = await db.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
          throw new ProblemDetailsError(404, 'user_not_found', 'User not found.');
        }
        return res.json({ user: toPublicUser(user) });
      } catch (err) {
        next(err);
        return
      }
    },
  };
}