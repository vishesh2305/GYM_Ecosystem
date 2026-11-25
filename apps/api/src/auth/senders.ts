import { Logger } from "@nestjs/common";
import { createTransport } from "nodemailer";
import type { ApiEnv } from "../env";

/**
 * Indian SMS must match a template registered on the DLT platform, so every SMS names its template (a key
 * mapped to the provider's template id in MSG91_TEMPLATE_IDS) and its variable values in order. `text` is the
 * same message written out, for logs and the console sender.
 */
export interface SmsMessage {
  text: string;
  template: string;
  params: readonly string[];
}

export interface SmsSender {
  /** Resolves with the provider's message id. */
  send(to: string, message: SmsMessage): Promise<string>;
}

/** Development/test sender: logs the message and keeps the last 100 in memory. Refused in production. */
export class ConsoleSmsSender implements SmsSender {
  readonly sent: { to: string; text: string; template: string }[] = [];
  private readonly logger = new Logger("SMS");

  async send(to: string, message: SmsMessage): Promise<string> {
    this.sent.push({ to, text: message.text, template: message.template });
    if (this.sent.length > 100) this.sent.shift();
    this.logger.log(`to ${to}: ${message.text}`);
    return `console-${Date.now()}`;
  }
}

/** MSG91 Flow API: sends a DLT-registered template with VAR1…VARn filled from the message's params. */
export class Msg91SmsSender implements SmsSender {
  constructor(
    private readonly options: { url: string; authKey: string; templateIds: Record<string, string> },
  ) {}

  async send(to: string, message: SmsMessage): Promise<string> {
    const templateId = this.options.templateIds[message.template];
    if (!templateId) throw new Error(`No DLT template id configured for "${message.template}"`);
    const vars = Object.fromEntries(message.params.map((value, i) => [`VAR${i + 1}`, value]));
    const res = await fetch(this.options.url, {
      method: "POST",
      headers: {
        authkey: this.options.authKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        template_id: templateId,
        short_url: "0",
        recipients: [{ mobiles: to.replace(/^\+/, ""), ...vars }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || body.type !== "success")
      throw new Error(`MSG91 refused the SMS (${res.status}): ${body.message ?? "no reason"}`);
    return body.message ?? "";
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

/** The SMS sender the environment asks for (env validation blocks "console" in production). */
export function createSmsSender(env: ApiEnv): SmsSender {
  return env.SMS_PROVIDER === "msg91" && env.MSG91_AUTH_KEY
    ? new Msg91SmsSender({
        url: env.MSG91_FLOW_URL,
        authKey: env.MSG91_AUTH_KEY,
        templateIds: env.MSG91_TEMPLATE_IDS,
      })
    : new ConsoleSmsSender();
}

export function createEmailSender(env: ApiEnv): EmailSender {
  return env.EMAIL_PROVIDER === "smtp" && env.SMTP_URL
    ? new SmtpEmailSender(createTransport(env.SMTP_URL), env.EMAIL_FROM)
    : new ConsoleEmailSender();
}
