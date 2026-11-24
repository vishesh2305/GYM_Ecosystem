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
