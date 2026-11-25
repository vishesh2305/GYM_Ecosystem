import { createDb, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { auditLog, otpChallenges, outboxEvents } from "@gym/db/schema";
import { parseEnv } from "@gym/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ConsoleSmsSender } from "../src/auth/senders";
import { apiEnvSchema } from "../src/env";
import { SMS_SENDER } from "../src/tokens";
import { rawTestEnv, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let sms: ConsoleSmsSender;
let ipCounter = 0;
const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

const requestCode = (phone: string, ip = nextIp()) =>
  api.inject({
    method: "POST",
    url: "/v1/auth/otp/request",
    payload: { channel: "sms", phone },
    remoteAddress: ip,
  });
const verify = (challengeId: string, code: string, ip = nextIp()) =>
  api.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    payload: { challengeId, code, deviceName: "Test phone" },
    remoteAddress: ip,
  });
const lastCodeFor = (phone: string) => {
  const message = [...sms.sent].reverse().find((m) => m.to === phone);
  return /\b(\d{6})\b/.exec(message?.text ?? "")?.[1] ?? "";
};
const randomPhone = () => `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  sms = api.get(SMS_SENDER);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

describe("sign in with a code sent by SMS", () => {
  it("sends a 6-digit code to the normalised number and signs in a new user", async () => {
    const local = randomPhone();
    const req = await requestCode(local);
    expect(req.statusCode).toBe(202);
    const { challengeId, expiresAt } = req.json();
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const e164 = `+91${local}`;
    const code = lastCodeFor(e164);
    expect(code).toMatch(/^\d{6}$/);

    const res = await verify(challengeId, code);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tokenType: "Bearer", isNewUser: true });
    const me = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.json().phone).toBe(e164);
  });

  it("signs the same person into the same account next time", async () => {
    const phone = randomPhone();
    const first = (
      await verify((await requestCode(phone)).json().challengeId, lastCodeFor(`+91${phone}`))
    ).json();
    const second = (
      await verify((await requestCode(phone)).json().challengeId, lastCodeFor(`+91${phone}`))
    ).json();
    expect(second.isNewUser).toBe(false);
    const meA = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    const meB = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(meA.json().id).toBe(meB.json().id);
  });

  it("records a sign-in audit entry and a 'user registered' event for new users", async () => {
    const phone = randomPhone();
    const res = await verify(
      (await requestCode(phone)).json().challengeId,
      lastCodeFor(`+91${phone}`),
    );
    const me = await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    });
    const userId = me.json().id;
    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "user.registered"));
    expect(events.some((e) => (e.payload as { userId: string }).userId === userId)).toBe(true);
    const audit = await dbh.db.select().from(auditLog).where(eq(auditLog.actorId, userId));
    expect(audit.map((a) => a.action)).toContain("auth.signed_in");
  });

  it("stores only a hash of the code", async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestCode(phone)).json();
    const [row] = await dbh.db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.id, challengeId));
    expect(JSON.stringify(row)).not.toContain(lastCodeFor(`+91${phone}`));
  });

  it("rejects an invalid phone number", async () => {
    const res = await requestCode("12345");
    expect(res.statusCode).toBe(400);
  });
});

describe("codes are hard to abuse", () => {
  it("a code works only once", async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestCode(phone)).json();
    const code = lastCodeFor(`+91${phone}`);
    expect((await verify(challengeId, code)).statusCode).toBe(200);
    expect((await verify(challengeId, code)).statusCode).toBe(400);
  });

  it("a wrong code says how many tries are left; after 5 wrong tries even the right code fails", async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestCode(phone)).json();
    const right = lastCodeFor(`+91${phone}`);
    const wrong = right === "000000" ? "111111" : "000000";
    const first = await verify(challengeId, wrong);
    expect(first.statusCode).toBe(400);
    expect(first.json().detail).toMatch(/4 attempts left/);
    for (let i = 0; i < 4; i++) await verify(challengeId, wrong);
    const locked = await verify(challengeId, right);
    expect(locked.statusCode).toBe(429);
  });

  it("a code expires", async () => {
    const quick = await createApp(testEnv({ OTP_TTL_SECONDS: "1" }));
    try {
      const phone = randomPhone();
      const req = await quick.app.inject({
        method: "POST",
        url: "/v1/auth/otp/request",
        payload: { channel: "sms", phone },
      });
      const code =
        /\b(\d{6})\b/.exec(
          quick.app.get<ConsoleSmsSender>(SMS_SENDER).sent.at(-1)?.text ?? "",
        )?.[1] ?? "";
      await new Promise((r) => setTimeout(r, 1100));
      const res = await quick.app.inject({
        method: "POST",
        url: "/v1/auth/otp/verify",
        payload: { challengeId: req.json().challengeId, code },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/expired/);
    } finally {
      await quick.app.close();
    }
  });

  it("at most 3 codes per number every 15 minutes", async () => {
    const phone = randomPhone();
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await requestCode(phone)).statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);
  });

  it("at most 10 code requests per minute from one network address", async () => {
    const ip = "10.250.0.1";
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await requestCode(randomPhone(), ip)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("refuses test sign-in numbers in production", () => {
    const env = (DEPLOY_ENV: string) =>
      parseEnv(apiEnvSchema, rawTestEnv({ DEPLOY_ENV, OTP_TEST_NUMBERS: "+919900000009:123456" }));
    expect(env("staging").OTP_TEST_NUMBERS.get("+919900000009")).toBe("123456");
    expect(() => env("production")).toThrow(/OTP_TEST_NUMBERS/);
    expect(() =>
      parseEnv(apiEnvSchema, rawTestEnv({ OTP_TEST_NUMBERS: "+919900000009:12" })),
    ).toThrow(/OTP_TEST_NUMBERS/);
  });

  it("refuses to start in production with the development SMS sender", () => {
    expect(() =>
      parseEnv(apiEnvSchema, rawTestEnv({ NODE_ENV: "production", SMS_PROVIDER: "console" })),
    ).toThrow(/SMS_PROVIDER/);
  });
});

describe("test sign-in numbers (staging)", () => {
  it("sign in with their fixed code, send nothing, and keep every other limit", async () => {
    const app = (
      await createApp(testEnv({ DEPLOY_ENV: "staging", OTP_TEST_NUMBERS: "+919900000009:246810" }))
    ).app;
    const sender = app.get<ConsoleSmsSender>(SMS_SENDER);
    const ask = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/otp/request",
        payload: { channel: "sms", phone: "9900000009" },
        remoteAddress: nextIp(),
      });
    const check = (challengeId: string, code: string) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/otp/verify",
        payload: { challengeId, code },
        remoteAddress: nextIp(),
      });
    try {
      const wrong = (await ask()).json<{ challengeId: string }>();
      expect((await check(wrong.challengeId, "111111")).statusCode).toBe(400);
      const right = (await ask()).json<{ challengeId: string }>();
      expect((await check(right.challengeId, "246810")).statusCode).toBe(200);
      expect(sender.sent.filter((m) => m.to === "+919900000009")).toEqual([]);
      expect((await ask()).statusCode).toBe(202);
      expect((await ask()).statusCode).toBe(429); // 3 codes per 15 minutes, as for everyone
    } finally {
      await app.close();
    }
  });
});
