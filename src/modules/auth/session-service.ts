// eslint-disable-next-line import/no-unresolved
import { ProblemDetailsError } from '../../common/errors.js';
import { Env } from '../../config/env.js';
import { Db } from '../../infrastructure/database/db.js';

import {
  AccessTokenPayload,
  generateRefreshToken,
  hashRefreshToken,
  IssuedAccessToken,
  signAccessToken,
} from './tokens.js';

export interface SessionRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;    // raw — returned to the client once
  refreshTokenExpiresAt: Date;
  sessionId: string;
  userId: string;
  roles: string[];
}

export interface SessionServiceDeps {
  db: Db;
  env: Env;
}

export function buildSessionService({ db, env }: SessionServiceDeps) {
  async function issueForUser(
    userId: string,
    roles: string[],
    meta: SessionRequestMeta,
    familyId: string,
  ): Promise<AuthResult> {
    const { raw, hash } = generateRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000,
    );

    const session = await db.session.create({
      data: {
        userId,
        refreshTokenHash: hash,
        familyId,
        expiresAt: refreshExpiresAt,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    const payload: AccessTokenPayload = { sub: userId, sid: session.id, roles };
    const access: IssuedAccessToken = signAccessToken(payload, env);

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: raw,
      refreshTokenExpiresAt: refreshExpiresAt,
      sessionId: session.id,
      userId,
      roles,
    };
  }

  return {
    /**
     * Begin a new session for a user (after login).
     * Creates a fresh family.
     */
    async startSession(
      userId: string,
      roles: string[],
      meta: SessionRequestMeta,
    ): Promise<AuthResult> {
      const familyId = crypto.randomUUID();
      return issueForUser(userId, roles, meta, familyId);
    },

    /**
     * Rotate a refresh token.
     *
     * Rules:
     *  - Unknown raw token: reject (could be from another environment).
     *  - Session revoked / expired: reject.
     *  - Session reused (already rotated): revoke the ENTIRE family, reject.
     *  - Otherwise: revoke current session, issue a new one in the same family.
     */
    async rotate(
      refreshToken: string,
      meta: SessionRequestMeta,
    ): Promise<AuthResult> {
      const hash = hashRefreshToken(refreshToken);
      const current = await db.session.findUnique({
        where: { refreshTokenHash: hash },
        include: { user: { select: { id: true, roles: true, status: true } } },
      });

      if (!current) {
        throw new ProblemDetailsError(
          401,
          'invalid_refresh_token',
          'Refresh token is invalid.',
        );
      }

      // Reuse detection: this session was already rotated (replacedById set)
      // or it was explicitly revoked after rotation. In that case somebody
      // is replaying an old token — nuke the whole family.
      if (current.replacedById || current.revokedAt) {
        await db.session.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokeReason: 'refresh_token_reuse_detected',
          },
        });
        throw new ProblemDetailsError(
          401,
          'refresh_token_reused',
          'Refresh token has already been used. All sessions in this family have been revoked.',
        );
      }

      if (current.expiresAt.getTime() <= Date.now()) {
        await db.session.update({
          where: { id: current.id },
          data: { revokedAt: new Date(), revokeReason: 'expired' },
        });
        throw new ProblemDetailsError(
          401,
          'refresh_token_expired',
          'Refresh token has expired.',
        );
      }

      if (current.user.status !== 'ACTIVE') {
        throw new ProblemDetailsError(
          403,
          'account_inactive',
          'Account is not active.',
        );
      }


      const next = await issueForUser(
        current.userId,
        current.user.roles,
        meta,
        current.familyId,
      );

      await db.session.update({
        where: { id: current.id },
        data: {
          revokedAt: new Date(),
          revokeReason: 'rotated',
          replacedById: next.sessionId,
        },
      });

      return next;
    },

    /**
     * Revoke a single session by its raw refresh token.
     * Used by /auth/logout.
     * Idempotent: revoking an already-revoked session is fine.
     */
    async revokeByToken(refreshToken: string): Promise<void> {
      const hash = hashRefreshToken(refreshToken);
      const session = await db.session.findUnique({
        where: { refreshTokenHash: hash },
      });
      if (!session) return;
      if (session.revokedAt) return;
      await db.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokeReason: 'logout' },
      });
    },

    /**
     * Revoke every active session for a user.
     * Used by /auth/logout-all.
     */
    async revokeAllForUser(userId: string, reason = 'logout_all'): Promise<void> {
      await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      });
    },
  };
}

export type SessionService = ReturnType<typeof buildSessionService>;