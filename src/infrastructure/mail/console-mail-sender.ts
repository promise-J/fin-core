import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MailMessage, MailSender } from './mail-sender';

export function buildFileMailSender(dir: string): MailSender {
  return {
    async send(msg: MailMessage) {
      await mkdir(dir, { recursive: true });
      const fileName = `${Date.now()}-${randomUUID()}.eml`;
      const content = [
        `To: ${msg.to}`,
        `Subject: ${msg.subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        msg.bodyText,
      ].join('\n');
      await writeFile(join(dir, fileName), content, 'utf8');
    },
  };
}