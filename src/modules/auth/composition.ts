import { Env } from '../../config/env.js';
import { Db } from '../../infrastructure/database/db.js';
import { argonPasswordHasher, PasswordHasher } from '../users/password.js';
import { buildUsersService, UsersService } from '../users/service.js';

import { buildSessionService, SessionService } from './session-service.js';

export interface AuthComposition {
  users: UsersService;
  sessions: SessionService;
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
  return {
    users: buildUsersService({ db, hasher }),
    sessions: buildSessionService({ db, env }),
  };
}