import type { ErrorRequestHandler } from 'express';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    public readonly detail?: string,
    public readonly type: string = 'about:blank',
  ) {
    super(title);
    this.name = 'HttpError';
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const problem: ProblemDetails =
    err instanceof HttpError
      ? {
          type: err.type,
          title: err.title,
          status: err.status,
          instance: req.originalUrl,
          requestId: req.requestId,
        }
      : {
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          instance: req.originalUrl,
          requestId: req.requestId,
        };
  if (err instanceof HttpError && err.detail !== undefined) {
    problem.detail = err.detail;
  }

  req.log?.error({ err, requestId: req.requestId }, 'unhandled_error');
  res.status(problem.status).type('appplication/problem+json').json(problem);
};
