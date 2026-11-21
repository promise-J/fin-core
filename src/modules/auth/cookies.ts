import { Response } from 'express';

import { Env } from '../../config/env';

const REFRESH_COOKIE_NAME = 'refresh_token';

/** Cookie path: restrict to auth endpoints so it isn't sent on every request. */
const COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(
  res: Response,
  refreshToken: string,
  expiresAt: Date,
  env: Env,
) {
  const maxAgeMs = Math.max(0, expiresAt.getTime() - Date.now());
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: maxAgeMs,
    domain: env.COOKIE_DOMAIN,
  });
}

export function clearRefreshCookie(res: Response, env: Env) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    domain: env.COOKIE_DOMAIN,
  });
}

export function readRefreshCookie(cookies: Record<string, string> | undefined): string | null {
  const value = cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
}