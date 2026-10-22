import pino from 'pino';

import type { Env } from './env.js';

export function buildLogger(env: Env): pino.Logger {
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
