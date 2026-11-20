import { Request, Response, NextFunction } from 'express';

import { ProblemDetailsError } from '../../common/errors.js';
import { Db } from '../../infrastructure/database/db.js';
import { toPublicUser } from '../users/service.js';

export function buildAuthController({ db }: { db: Db }) {
  return {
    async me(req: Request, res: Response, next: NextFunction) {
      try {
        if (!req.user) {
          throw new ProblemDetailsError(
            401,
            'not_authenticated',
            'Authentication required.',
          );
        }
        const user = await db.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
          throw new ProblemDetailsError(404, 'user_not_found', 'User not found.');
        }
        return res.json({ user: toPublicUser(user) });
      } catch (err) {
        next(err);
        return;
      }
    },
  };
}