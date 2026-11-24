import { createTransport } from "nodemailer";
import { parseEnv } from "@gym/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiEnvSchema } from "../src/env";
import { createApp } from "../src/app";
import type { ConsoleEmailSender } from "../src/auth/senders";
import { SmtpEmailSender } from "../src/auth/senders";
import { EMAIL_SENDER } from "../src/tokens";
import { testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let mail: ConsoleEmailSender;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  mail = api.get(EMAIL_SENDER);
});
afterAll(async () => {
  await api.close();
});

const codeIn = (text = "") => /\b(\d{6})\b/.exec(text)?.[1] ?? "";

describe("sign in with a code sent by email", () => {
  it("emails a code to the lower-cased address and signs in a new user", async () => {
    const email = `Asha.${Date.now()}@Example.COM`;
    const req = await api.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { channel: "email", email },
    });
    expect(req.statusCode).toBe(202);
    const message = mail.sent.at(-1);
    expect(message?.to).toBe(email.toLowerCase());
    expect(message?.subject).toMatch(/sign-in code/i);

    const res = await api.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      payload: { challengeId: req.json().challengeId, code: codeIn(message?.text) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isNewUser).toBe(true);
    const me = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    });
    expect(me.json()).toMatchObject({ email: email.toLowerCase(), phone: null });
  });

  it("signs a returning email user into the same account", async () => {
    const email = `returning.${Date.now()}@example.com`;
    const signIn = async () => {
      const req = await api.inject({
        method: "POST",
        url: "/v1/auth/otp/request",
        payload: { channel: "email", email },
      });
      return api.inject({
        method: "POST",
        url: "/v1/auth/otp/verify",
        payload: { challengeId: req.json().challengeId, code: codeIn(mail.sent.at(-1)?.text) },
      });
    };
    expect((await signIn()).json().isNewUser).toBe(true);
    expect((await signIn()).json().isNewUser).toBe(false);
  });

  it("answers 503 'try again' when the email server cannot be reached", async () => {
    const broken = await createApp(
      testEnv({ EMAIL_PROVIDER: "smtp", SMTP_URL: "smtp://127.0.0.1:1" }),
    );
    try {
      const res = await broken.app.inject({
        method: "POST",
        url: "/v1/auth/otp/request",
        payload: { channel: "email", email: "x@example.com" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().detail).toMatch(/try again/);
    } finally {
      await broken.app.close();
    }
  });

  it("rejects an invalid email address", async () => {
    const res = await api.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { channel: "email", email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("email settings", () => {
  const base = () => {
    const env = testEnv();
    return {
      DATABASE_URL: env.DATABASE_URL,
      REDIS_URL: env.REDIS_URL,
      JWT_PRIVATE_JWK: JSON.stringify(env.JWT_PRIVATE_JWK),
      AUTH_SECRET: env.AUTH_SECRET,
    };
  };
  it("require SMTP_URL when sending through SMTP", () => {
    expect(() => parseEnv(apiEnvSchema, { ...base(), EMAIL_PROVIDER: "smtp" })).toThrow(/SMTP_URL/);
  });
  it("refuse the console email sender in production", () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...base(),
        NODE_ENV: "production",
        SMS_PROVIDER: "console",
        EMAIL_PROVIDER: "console",
      }),
    ).toThrow(/EMAIL_PROVIDER/);
  });
});

describe("SMTP email sender", () => {
  it("builds a plain-text email from the configured sender address", async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent: string[] = [];
    const sender = new SmtpEmailSender(
      {
        sendMail: async (m) => {
          sent.push((await transport.sendMail(m)).message as string);
          return {};
        },
      },
      "Gym Platform <no-reply@gym.test>",
    );
    await sender.send({ to: "a@b.test", subject: "Hi", text: "Code 123456" });
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      from: { address: "no-reply@gym.test", name: "Gym Platform" },
      to: [{ address: "a@b.test" }],
      subject: "Hi",
      text: "Code 123456",
    });
  });
});
