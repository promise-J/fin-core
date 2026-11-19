export class ProblemDetailsError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ProblemDetailsError';
    }
  }
  
  export interface ProblemDetails {
    type: string;
    title: string;
    status: number;
    detail?: string;
    code: string;
    [k: string]: unknown;
  }
  
  export function toProblemDetails(err: unknown): ProblemDetails {
    if (err instanceof ProblemDetailsError) {
      return {
        type: `https://fincore.example/problems/${err.code}`,
        title: err.code,
        status: err.status,
        detail: err.message,
        code: err.code,
        ...(err.details ?? {}),
      };
    }
    // Unknown error — do not leak internals.
    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'internal_error',
    };
  }