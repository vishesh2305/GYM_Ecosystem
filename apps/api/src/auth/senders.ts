import { Logger } from "@nestjs/common";

export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/** Development/test sender: logs the message and keeps the last 100 in memory. Refused in production. */
export class ConsoleSmsSender implements SmsSender {
  readonly sent: { to: string; text: string }[] = [];
  private readonly logger = new Logger("SMS");

  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    if (this.sent.length > 100) this.sent.shift();
    this.logger.log(`to ${to}: ${text}`);
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Development/test sender: logs and keeps the last 100 emails. Refused in production. */
export class ConsoleEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  private readonly logger = new Logger("Email");

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    this.logger.log(`to ${message.to}: ${message.subject}`);
  }
}

/** Sends through any SMTP server: Mailpit locally, Amazon SES (SMTP interface) in production. */
export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly transport: {
      sendMail(mail: { from: string } & EmailMessage): Promise<unknown>;
    },
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
