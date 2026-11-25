import { parseEnv } from "@gym/config";
import { renderMessage } from "@gym/domain";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConsoleEmailSender,
  ConsoleSmsSender,
  createEmailSender,
  createSmsSender,
  Msg91SmsSender,
} from "../src/auth/senders";
import { apiEnvSchema } from "../src/env";
import {
  ConsoleChannel,
  createChannels,
  EmailChannel,
  ExpoPushChannel,
  SmsChannel,
  WhatsAppCloudChannel,
  type Outgoing,
  type Recipient,
} from "../src/notifications/channels";
import { rawTestEnv } from "./helpers";

// A local stand-in for Expo, the WhatsApp Cloud API and MSG91 that records requests and answers as told.
const seen: { url: string; headers: Record<string, unknown>; body: unknown }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "null") });
    res.statusCode = reply.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  seen.length = 0;
});

const outgoing: Outgoing = {
  key: "class_reminder",
  locale: "hi",
  message: renderMessage(
    "class_reminder",
    "hi",
    { name: "Asha", className: "Yoga", startsAt: "2026-12-01T01:30:00Z" },
    "Asia/Kolkata",
  ),
};
const member: Recipient = {
  phone: "+919812345678",
  email: "asha@example.com",
  pushTokens: ["ExponentPushToken[a]", "ExponentPushToken[b]"],
};

describe("Expo push", () => {
  const expo = () => new ExpoPushChannel(`${base}/push`, "expo-secret");

  it("sends one notification per phone and reports uninstalled apps", async () => {
    reply = {
      status: 200,
      body: {
        data: [
          { status: "ok", id: "ticket-1" },
          { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        ],
      },
    };
    const result = await expo().send(member, outgoing);
    expect(result).toEqual({ providerId: "ticket-1", deadTokens: ["ExponentPushToken[b]"] });
    expect(seen[0]?.headers.authorization).toBe("Bearer expo-secret");
    expect(seen[0]?.body).toEqual([
      expect.objectContaining({
        to: "ExponentPushToken[a]",
        title: outgoing.message.title,
        data: { key: "class_reminder" },
      }),
      expect.objectContaining({ to: "ExponentPushToken[b]" }),
    ]);
  });

  it("fails when no phone accepted it or Expo is down", async () => {
    reply = {
      status: 200,
      body: {
        data: [{ status: "error", message: "bad", details: { error: "DeviceNotRegistered" } }],
      },
    };
    await expect(expo().send({ ...member, pushTokens: ["x"] }, outgoing)).rejects.toMatchObject({
      message: "Expo push failed: bad",
      deadTokens: ["x"],
    });
    reply = { status: 503, body: {} };
    await expect(expo().send(member, outgoing)).rejects.toThrow("Expo push refused (503)");
    expect(expo().reaches({ ...member, pushTokens: [] })).toBe(false);
  });
});

describe("WhatsApp Cloud API", () => {
  const whatsapp = () => new WhatsAppCloudChannel(`${base}/wa`, "PNID", "wa-token");

  it("sends the approved template in the member's language with its variables in order", async () => {
    reply = { status: 200, body: { messages: [{ id: "wamid.1" }] } };
    expect(await whatsapp().send(member, outgoing)).toEqual({ providerId: "wamid.1" });
    expect(seen[0]?.url).toBe("/wa/PNID/messages");
    expect(seen[0]?.headers.authorization).toBe("Bearer wa-token");
    expect(seen[0]?.body).toEqual({
      messaging_product: "whatsapp",
      to: "919812345678",
      type: "template",
      template: {
        name: "class_reminder",
        language: { code: "hi" },
        components: [
          {
            type: "body",
            parameters: outgoing.message.params.map((text) => ({ type: "text", text })),
          },
        ],
      },
    });
  });

  it("fails with WhatsApp's reason", async () => {
    reply = { status: 400, body: { error: { message: "Template not approved" } } };
    await expect(whatsapp().send(member, outgoing)).rejects.toThrow(
      "WhatsApp refused (400): Template not approved",
    );
    expect(whatsapp().reaches({ ...member, phone: null })).toBe(false);
  });
});

describe("MSG91 SMS (DLT)", () => {
  const msg91 = () =>
    new Msg91SmsSender({ url: `${base}/flow`, authKey: "auth-k", templateIds: { otp: "tpl-otp" } });

  it("sends the DLT template with the values as VAR1, VAR2 …", async () => {
    reply = { status: 200, body: { type: "success", message: "req-42" } };
    const id = await msg91().send("+919812345678", {
      text: "123456 is your code",
      template: "otp",
      params: ["123456", "5"],
    });
    expect(id).toBe("req-42");
    expect(seen[0]?.headers.authkey).toBe("auth-k");
    expect(seen[0]?.body).toEqual({
      template_id: "tpl-otp",
      short_url: "0",
      recipients: [{ mobiles: "919812345678", VAR1: "123456", VAR2: "5" }],
    });
  });

  it("refuses messages without a registered template and reports MSG91 errors", async () => {
    await expect(
      msg91().send("+919812345678", { text: "x", template: "renewal_due", params: [] }),
    ).rejects.toThrow('No DLT template id configured for "renewal_due"');
    expect(seen).toHaveLength(0);
    reply = { status: 200, body: { type: "error", message: "Invalid template" } };
    await expect(
      msg91().send("+919812345678", { text: "x", template: "otp", params: [] }),
    ).rejects.toThrow("MSG91 refused the SMS (200): Invalid template");
  });
});

describe("SMS and email channels", () => {
  it("pass the message key as the SMS template and the title as the email subject", async () => {
    const sms = new ConsoleSmsSender();
    const mail = new ConsoleEmailSender();
    await new SmsChannel(sms).send(member, outgoing);
    await new EmailChannel(mail).send(member, outgoing);
    expect(sms.sent[0]).toEqual({
      to: member.phone,
      text: outgoing.message.body,
      template: "class_reminder",
    });
    expect(mail.sent[0]).toEqual({
      to: member.email,
      subject: outgoing.message.title,
      text: outgoing.message.body,
    });
    expect(new EmailChannel(mail).reaches({ ...member, email: null })).toBe(false);
    expect(new SmsChannel(sms).reaches({ ...member, phone: null })).toBe(false);
  });

  it("console channels log what they would send", async () => {
    const push = new ConsoleChannel("push");
    const whatsapp = new ConsoleChannel("whatsapp");
    await push.send(member, outgoing);
    await whatsapp.send(member, outgoing);
    expect(push.sent[0]?.to).toBe(member.pushTokens.join(","));
    expect(whatsapp.sent[0]?.to).toBe(member.phone);
    expect(push.reaches({ ...member, pushTokens: [] })).toBe(false);
  });
});

describe("configured providers", () => {
  const env = (extra: Record<string, string> = {}) => parseEnv(apiEnvSchema, rawTestEnv(extra));

  it("default to console senders in development, in the order push, WhatsApp, SMS, email", () => {
    const channels = createChannels(env(), createSmsSender(env()), createEmailSender(env()));
    expect(channels.map((c) => c.channel)).toEqual(["push", "whatsapp", "sms", "email"]);
    expect(channels[0]).toBeInstanceOf(ConsoleChannel);
    expect(createSmsSender(env())).toBeInstanceOf(ConsoleSmsSender);
  });

  it("use the real providers when chosen, and leave WhatsApp out when it is off", () => {
    const live = env({
      PUSH_PROVIDER: "expo",
      WHATSAPP_PROVIDER: "cloud",
      WHATSAPP_PHONE_NUMBER_ID: "1",
      WHATSAPP_TOKEN: "t",
      SMS_PROVIDER: "msg91",
      MSG91_AUTH_KEY: "k",
      MSG91_TEMPLATE_IDS: '{"otp":"tpl"}',
    });
    const channels = createChannels(live, createSmsSender(live), createEmailSender(live));
    expect(channels[0]).toBeInstanceOf(ExpoPushChannel);
    expect(channels[1]).toBeInstanceOf(WhatsAppCloudChannel);
    expect(createSmsSender(live)).toBeInstanceOf(Msg91SmsSender);
    const off = env({ WHATSAPP_PROVIDER: "off" });
    expect(
      createChannels(off, createSmsSender(off), createEmailSender(off)).map((c) => c.channel),
    ).toEqual(["push", "sms", "email"]);
  });

  it("refuse incomplete or development settings in production", () => {
    const fails = (extra: Record<string, string>) => () => env(extra);
    expect(fails({ SMS_PROVIDER: "msg91" })).toThrow(/MSG91_AUTH_KEY/);
    expect(fails({ WHATSAPP_PROVIDER: "cloud" })).toThrow(/WHATSAPP_TOKEN/);
    expect(fails({ NODE_ENV: "production" })).toThrow(/PUSH_PROVIDER/);
  });
});
