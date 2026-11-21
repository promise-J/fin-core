import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';
import { argonPasswordHasher, PasswordHasher } from '../users/password';
import { buildUsersService, UsersService } from '../users/service';

import { buildDbEmailQueue, EmailQueue } from './email-queue';
import { buildVerificationService, VerificationService } from './service';
import { buildSessionService, SessionService } from './session-service';

export interface AuthComposition {
  users: UsersService;
  sessions: SessionService;
  verification: VerificationService;
  emailQueue: EmailQueue;
}

export function buildAuthComposition({
  db,
  env,
  hasher = argonPasswordHasher,
}: {
  db: Db;
  env: Env;
  hasher?: PasswordHasher;
}): AuthComposition {
  const emailQueue = buildDbEmailQueue(db);

  return {
    users: buildUsersService({ db, hasher }),
    sessions: buildSessionService({ db, env }),
    verification: buildVerificationService({ db, env, emailQueue }),
    emailQueue,
  };
}