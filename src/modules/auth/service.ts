import { Prisma } from '@prisma/client';

import { ProblemDetailsError } from '../../common/errors';
import { Env } from '../../config/env';
import { Db } from '../../infrastructure/database/db';

import { EmailQueue } from './email-queue';
import {
  buildVerificationEmail,
  generateVerificationToken,
  hashVerificationToken,
} from './verification';

export interface VerificationServiceDeps {
  db: Db;
  env: Env;
  emailQueue: EmailQueue;
}

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function buildVerificationService(deps: VerificationServiceDeps) {
  const { env } = deps;

  return {
    /**
     * Enqueue a verification email and persist a matching token row.
     * Called inside the registration transaction — see users/service.ts
     * (2.5.3 rewrites it to accept a transaction client).
     */
    async issue(tx: Prisma.TransactionClient, userId: string, email: string) {
      const { raw, hash } = generateVerificationToken();
      await tx.emailVerificationToken.create({
        data: {
          userId,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      });

      const baseUrl = env.CORS_ORIGIN;
      const emailBody = buildVerificationEmail(baseUrl, raw);
      await tx.emailOutbox.create({
        data: {
          toAddress: email,
          subject: emailBody.subject,
          bodyText: emailBody.bodyText,
        },
      });
    },

    /**
     * Consume a verification token. Marks the user verified and the
     * token consumed in the same transaction.
     */
    async verify(rawToken: string) {
      const hash = hashVerificationToken(rawToken);
      const db = deps.db;

      await db.$transaction(async (tx) => {
        const token = await tx.emailVerificationToken.findUnique({
          where: { tokenHash: hash },
        });
        if (!token) {
          throw new ProblemDetailsError(
            400,
            'invalid_token',
            'Verification token is invalid.',
          );
        }
        if (token.consumedAt) {
          throw new ProblemDetailsError(
            400,
            'token_already_used',
            'This verification link has already been used.',
          );
        }
        if (token.expiresAt.getTime() <= Date.now()) {
          throw new ProblemDetailsError(
            400,
            'token_expired',
            'This verification link has expired. Please request a new one.',
          );
        }

        await tx.user.update({
          where: { id: token.userId },
          data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
        });
        await tx.emailVerificationToken.update({
          where: { id: token.id },
          data: { consumedAt: new Date() },
        });
      });
    },
  };
}

export type VerificationService = ReturnType<typeof buildVerificationService>;