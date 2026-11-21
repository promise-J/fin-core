import { Db } from '../../infrastructure/database/db';
import { MailMessage } from '../../infrastructure/mail/mail-sender';

export interface EmailQueue {
  enqueue(message: MailMessage): Promise<void>;
}

export function buildDbEmailQueue(db: Db): EmailQueue {
  return {
    async enqueue(message) {
      await db.emailOutbox.create({
        data: {
          toAddress: message.to,
          subject: message.subject,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml ?? null,
        },
      });
    },
  };
}