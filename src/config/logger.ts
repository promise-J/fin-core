import pino from 'pino';

import type { Env } from './env';

export function buildLogger(
  env: Pick<
    Env,
    'LOG_LEVEL' | 'SERVICE_NAME' | 'NODE_ENV' | 'REDIS_URL' | 'DATABASE_URL' | 'JWT_ACCESS_SECRET'
  >,
): pino.Logger {
  const options: pino.LoggerOptions = {
    name: env.SERVICE_NAME,
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'password',
        '*.password',
        'token',
        '*.token',
        'refreshToken',
        '*.refreshToken',
      ],
      remove: true,
    },
  };
  if (env.NODE_ENV === 'development') {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  return pino(options);
}

export type AppLogger = ReturnType<typeof buildLogger>;
