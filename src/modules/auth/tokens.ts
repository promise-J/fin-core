import crypto from 'node:crypto';


import * as jwt from 'jsonwebtoken'

const { sign, verify } = jwt

// eslint-disable-next-line import/no-unresolved
import { ProblemDetailsError } from '../../common/errors';
import { Env } from '../../config/env';

const REFRESH_TOKEN_BYTES = 32;

/**
 * Generate a new opaque refresh token.
 * Returns both the raw token (to send to the client, once) and
 * the SHA-256 hash (to store in the Session row).
 */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const hash = hashRefreshToken(raw);
  return { raw, hash };
}

export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface AccessTokenPayload {
  sub: string;         // user id
  sid: string;         // session id — lets logout revoke specific sessions
  roles: string[];
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export function signAccessToken(
  payload: AccessTokenPayload,
  env: Env,
): IssuedAccessToken {
  const expiresInSeconds = env.JWT_ACCESS_TTL_SECONDS;
  const token = sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
    issuer: env.SERVICE_NAME,
    audience: env.SERVICE_NAME,
  });
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  return { token, expiresAt };
}

export function verifyAccessToken(
  token: string,
  env: Env,
): AccessTokenPayload {
  try {
    const decoded = verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: env.SERVICE_NAME,
      audience: env.SERVICE_NAME,
    });

    if (typeof decoded !== 'object' || decoded === null) {
        throw new Error('malformed payload');
    }

    const payload = decoded as Record<string, unknown>;

    if (
      typeof payload['sub'] !== 'string' ||
      typeof payload['sid'] !== 'string' ||
      !Array.isArray(payload['roles'])
    ) {
      throw new Error('malformed payload');
    }
    
    return {
      sub: payload['sub'],
      sid: payload['sid'],
      roles: payload['roles'],
    };
  } catch {
    throw new ProblemDetailsError(401, 'invalid_access_token', 'Access token is invalid or expired.');
  }
}