export interface MailMessage {
    to: string;
    subject: string;
    bodyText: string;
    bodyHtml: string | undefined;
  }
  
  export interface MailSender {
    send(message: MailMessage): Promise<void>;
  }