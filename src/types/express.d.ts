import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: string;
      sessionId: string;
      roles: string[];
    };
    requestId?: string;
  }
}