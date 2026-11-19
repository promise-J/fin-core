import { Prisma } from '@prisma/client';

// eslint-disable-next-line import/no-unresolved
import { ProblemDetailsError } from '../../common/errors.js';
import { Db } from '../../infrastructure/database/db.js';

import { PasswordHasher } from './password.js';



export interface CreateUserInput {
  email: string;
  password: string;
  fullName?: string;
  phoneNumber?: string;
}

export interface UsersServiceDeps {
  db: Db;
  hasher: PasswordHasher;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string | null;
  phoneNumber: string | null;
  status: string;
  kycStatus: string;
  roles: string[];
  createdAt: Date;
}

export function buildUsersService({ db, hasher }: UsersServiceDeps) {
  return {
    async findByEmail(email: string) {
      return db.user.findUnique({ where: { email: email.toLowerCase() } });
    },

    async findById(id: string) {
      return db.user.findUnique({ where: { id } });
    },

    /**
     * Create a user. Email is lowercased before storage so that
     * 'Alice@Example.com' and 'alice@example.com' cannot both exist.
     * The unique constraint on User.email is the authoritative guard;
     * this just normalizes at the boundary.
     */
    async createUser(input: CreateUserInput): Promise<PublicUser> {
      const email = input.email.toLowerCase();
      const passwordHash = await hasher.hash(input.password);

      try {
        const user = await db.user.create({
          data: {
            email,
            passwordHash,
            fullName: input.fullName ?? null,
            phoneNumber: input.phoneNumber ?? null,
            status: 'ACTIVE',
            kycStatus: 'NOT_STARTED',
            roles: ['CUSTOMER'],
          },
        });
        return toPublicUser(user);
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ProblemDetailsError(
            409,
            'email_in_use',
            'An account with this email already exists.',
          );
        }
        throw err;
      }
    },
  };
}

export type UsersService = ReturnType<typeof buildUsersService>;

/**
 * Strip passwordHash and other sensitive fields.
 * Used when returning user data from any layer.
 */
export function toPublicUser(u: {
  id: string;
  email: string;
  fullName: string | null;
  phoneNumber: string | null;
  status: string;
  kycStatus: string;
  roles: string[];
  createdAt: Date;
}): PublicUser {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    phoneNumber: u.phoneNumber,
    status: u.status,
    kycStatus: u.kycStatus,
    roles: u.roles,
    createdAt: u.createdAt,
  };
}