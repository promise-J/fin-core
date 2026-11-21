import { Prisma } from '@prisma/client';

// eslint-disable-next-line import/no-unresolved
import { ProblemDetailsError } from '../../common/errors';
import { Db } from '../../infrastructure/database/db';

import { PasswordHasher } from './password';



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
     * Create a user. The caller can pass `afterCreate` to run additional
     * writes (e.g. issuing a verification token) inside the same DB
     * transaction — if the extra writes fail, the user is rolled back.
     */
    async createUser(
      input: CreateUserInput,
      afterCreate?: (
        tx: Prisma.TransactionClient,
        user: { id: string; email: string; roles: string[] },
      ) => Promise<void>,
    ): Promise<PublicUser> {
      const email = input.email.toLowerCase();
      const passwordHash = await hasher.hash(input.password);

      try {
        return await db.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email,
              passwordHash,
              fullName: input.fullName ?? null,
              phoneNumber: input.phoneNumber ?? null,
              status: 'PENDING_VERIFICATION',
              kycStatus: 'NOT_STARTED',
              roles: ['CUSTOMER'],
            },
          });
          if (afterCreate) {
            await afterCreate(tx, {
              id: user.id,
              email: user.email,
              roles: user.roles,
            });
          }
          return toPublicUser(user);
        });
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