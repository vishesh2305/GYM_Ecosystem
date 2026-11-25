import type { Channel, Locale, MessageKey, RenderedMessage } from "@gym/domain";
import { Logger } from "@nestjs/common";
import type { EmailSender, SmsSender } from "../auth/senders";
import type { ApiEnv } from "../env";

/** How a member can be reached. Push tokens are those of the app account linked to the member. */
export interface Recipient {
  phone: string | null;
  email: string | null;
  pushTokens: readonly string[];
}

export interface Outgoing {
  key: MessageKey;
  locale: Locale;
  message: RenderedMessage;
}

export interface SendResult {
  providerId: string | null;
  /** Push tokens the provider says no longer exist (app uninstalled): they are disabled. */
  deadTokens?: readonly string[];
}

/** A failed send; the next channel is tried. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly deadTokens: readonly string[] = [],
  ) {
    super(message);
  }
}

/** The port every delivery channel implements. */
export interface ChannelAdapter {
  readonly channel: Channel;
  reaches(recipient: Recipient): boolean;
  send(recipient: Recipient, outgoing: Outgoing): Promise<SendResult>;
}

const TIMEOUT_MS = 10_000;
const digits = (phone: string) => phone.replace(/^\+/, "");

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** App push through Expo's push service, which forwards to FCM (Android) and APNs (iOS). */
export class ExpoPushChannel implements ChannelAdapter {
  readonly channel = "push";
  constructor(
    private readonly url: string,
    private readonly accessToken?: string,
  ) {}

  reaches(r: Recipient) {
    return r.pushTokens.length > 0;
  }

  async send(r: Recipient, { key, message }: Outgoing): Promise<SendResult> {
    const { res, json } = await postJson(
      this.url,
      this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
      r.pushTokens.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        sound: "default",
        data: { key },
      })),
    );
    if (!res.ok) throw new SendError(`Expo push refused (${res.status})`);
    const tickets = (json.data ?? []) as {
      status?: string;
      id?: string;
      message?: string;
      details?: { error?: string };
    }[];
    const deadTokens = r.pushTokens.filter(
      (_, i) => tickets[i]?.details?.error === "DeviceNotRegistered",
    );
    const ok = tickets.filter((t) => t.status === "ok");
    if (!ok.length)
      throw new SendError(`Expo push failed: ${tickets[0]?.message ?? "no ticket"}`, deadTokens);
    return { providerId: ok.map((t) => t.id).join(","), deadTokens };
  }
}

/** WhatsApp Business Cloud API: the message's pre-approved template (named after its key) in the member's language. */
export class WhatsAppCloudChannel implements ChannelAdapter {
  readonly channel = "whatsapp";
  constructor(
    private readonly apiUrl: string,
    private readonly phoneNumberId: string,
    private readonly token: string,
  ) {}

  reaches(r: Recipient) {
    return r.phone !== null;
  }

  async send(r: Recipient, { key, locale, message }: Outgoing): Promise<SendResult> {
    const { res, json } = await postJson(
      `${this.apiUrl}/${this.phoneNumberId}/messages`,
      { authorization: `Bearer ${this.token}` },
      {
        messaging_product: "whatsapp",
        to: digits(r.phone ?? ""),
        type: "template",
        template: {
          name: key,
          language: { code: locale },
          components: [
            { type: "body", parameters: message.params.map((text) => ({ type: "text", text })) },
          ],
        },
      },
    );
    const sent = (json.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!res.ok || !sent) {
      const reason = (json.error as { message?: string } | undefined)?.message ?? "no reason";
      throw new SendError(`WhatsApp refused (${res.status}): ${reason}`);
    }
    return { providerId: sent };
  }
}

/** SMS through the DLT-aware SMS sender; the DLT template is the message key. */
export class SmsChannel implements ChannelAdapter {
  readonly channel = "sms";
  constructor(private readonly sms: SmsSender) {}

  reaches(r: Recipient) {
    return r.phone !== null;
  }

  async send(r: Recipient, { key, message }: Outgoing): Promise<SendResult> {
    const providerId = await this.sms.send(r.phone ?? "", {
      text: message.body,
      template: key,
      params: message.params,
    });
    return { providerId };
  }
}

export class EmailChannel implements ChannelAdapter {
  readonly channel = "email";
  constructor(private readonly email: EmailSender) {}

  reaches(r: Recipient) {
    return r.email !== null;
  }

  async send(r: Recipient, { message }: Outgoing): Promise<SendResult> {
    await this.email.send({ to: r.email ?? "", subject: message.title, text: message.body });
    return { providerId: null };
  }
}

/** Development/test channel: logs and keeps the last 100 messages. Refused in production for push and WhatsApp. */
export class ConsoleChannel implements ChannelAdapter {
  readonly sent: { to: string; key: MessageKey; title: string; body: string }[] = [];
  private readonly logger: Logger;

  constructor(readonly channel: Channel) {
    this.logger = new Logger(`notify:${channel}`);
  }

  reaches(r: Recipient) {
    return this.channel === "push" ? r.pushTokens.length > 0 : r.phone !== null;
  }

  async send(r: Recipient, { key, message }: Outgoing): Promise<SendResult> {
    const to = this.channel === "push" ? r.pushTokens.join(",") : (r.phone ?? "");
    this.sent.push({ to, key, title: message.title, body: message.body });
    if (this.sent.length > 100) this.sent.shift();
    this.logger.log(`to ${to}: ${message.title}`);
    return { providerId: `console-${Date.now()}` };
  }
}

/** The channels the environment configures, in the default order tried. */
export function createChannels(env: ApiEnv, sms: SmsSender, email: EmailSender): ChannelAdapter[] {
  const push =
    env.PUSH_PROVIDER === "expo"
      ? new ExpoPushChannel(env.EXPO_PUSH_URL, env.EXPO_ACCESS_TOKEN)
      : new ConsoleChannel("push");
  const whatsapp =
    env.WHATSAPP_PROVIDER === "cloud" && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TOKEN
      ? new WhatsAppCloudChannel(
          env.WHATSAPP_API_URL,
          env.WHATSAPP_PHONE_NUMBER_ID,
          env.WHATSAPP_TOKEN,
        )
      : env.WHATSAPP_PROVIDER === "off"
        ? null
        : new ConsoleChannel("whatsapp");
  const all: (ChannelAdapter | null)[] = [
    push,
    whatsapp,
    new SmsChannel(sms),
    new EmailChannel(email),
  ];
  return all.filter((c): c is ChannelAdapter => c !== null);
}
