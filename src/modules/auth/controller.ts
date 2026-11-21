import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';


import { ProblemDetailsError } from '../../common/errors';
import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';
import { PasswordHasher } from '../users/password';
import { UsersService, toPublicUser } from '../users/service';

import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies'
import {
  LoginBody,
  RegisterBody,
  parseOrThrow,
} from './schema';
import { VerificationService } from './service';
import { SessionService } from './session-service';

export interface AuthControllerDeps {
  db: Db;
  env: Env;
  users: UsersService;
  sessions: SessionService;
  verification: VerificationService,
  hasher: PasswordHasher;
}

const VerifyEmailBody = z.object({ token: z.string().min(1).max(512) });

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
  const { db, users, env, sessions, hasher, verification } = deps;

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
        },async (tx, u) => {
          await verification.issue(tx, u.id, u.email);
        },);

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

    async verifyEmail(req: Request, res: Response, next: NextFunction) {
      try {
        const input = parseOrThrow(VerifyEmailBody, req.body);
        await verification.verify(input.token);
        return res.status(204).send();
      } catch (err) {
        next(err);
        return
      }
    },

    async resendVerification(req: Request, res: Response, next: NextFunction) {
      try {
        const input = parseOrThrow(LoginBody.pick({ email: true }), req.body);
        const user = await users.findByEmail(input.email);
        // Uniform response — do not reveal if the email exists or is already verified.
        if (user && !user.emailVerifiedAt) {
          await db.$transaction(async (tx) => {
            await verification.issue(tx, user.id, user.email);
          });
        }
        return res.status(202).json({ message: 'If the account exists and is unverified, an email will be sent.' });
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