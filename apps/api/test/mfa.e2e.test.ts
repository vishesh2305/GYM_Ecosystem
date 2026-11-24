import { createDb, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { userMfa, users } from "@gym/db/schema";
import { decodeJwt } from "jose";
import { Secret, TOTP } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SessionService } from "../src/auth/session.service";
import { randomIp, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

const call = (method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: object) =>
  api.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: randomIp(),
    ...(payload && { payload }),
  });

async function signedInUser() {
  const [user] = await dbh.db
    .insert(users)
    .values({ email: `staff.${Date.now()}.${Math.random()}@gym.test` })
    .returning();
  if (!user) throw new Error("insert failed");
  const tokens = await api.get(SessionService).createSession(user.id, { amr: ["otp"] });
  return { user, ...tokens };
}

/** Code for the given 30-second step offset, computed like an authenticator app would. */
const codeFor = (secret: string, stepOffset = 0) =>
  TOTP.generate({ secret: Secret.fromBase32(secret), timestamp: Date.now() + stepOffset * 30_000 });

async function enrolled() {
  const s = await signedInUser();
  const setup = (await call("POST", "/v1/auth/mfa/totp/setup", s.accessToken)).json();
  const confirm = await call("POST", "/v1/auth/mfa/totp/confirm", s.accessToken, {
    code: codeFor(setup.secret),
  });
  return { ...s, secret: setup.secret as string, confirm };
}

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

describe("turning on two-step verification", () => {
  it("gives a QR link for an authenticator app, then 10 one-time recovery codes", async () => {
    const s = await signedInUser();
    const setup = await call("POST", "/v1/auth/mfa/totp/setup", s.accessToken);
    expect(setup.statusCode).toBe(201);
    expect(setup.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\/Gym%20Platform:/);

    const wrong = await call("POST", "/v1/auth/mfa/totp/confirm", s.accessToken, {
      code: "000000",
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await call("POST", "/v1/auth/mfa/totp/confirm", s.accessToken, {
      code: codeFor(setup.json().secret),
    });
    expect(ok.statusCode).toBe(200);
    const { recoveryCodes } = ok.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const status = await call("GET", "/v1/auth/mfa", s.accessToken);
    expect(status.json()).toEqual({ totpEnabled: true, recoveryCodesLeft: 10 });
  });

  it("stores the secret encrypted, never readable", async () => {
    const e = await enrolled();
    const [row] = await dbh.db.select().from(userMfa).where(eq(userMfa.userId, e.user.id));
    expect(row?.totpSecretEnc).toBeDefined();
    expect(row?.totpSecretEnc).not.toContain(e.secret);
  });

  it("cannot be set up twice while it is on", async () => {
    const e = await enrolled();
    expect((await call("POST", "/v1/auth/mfa/totp/setup", e.accessToken)).statusCode).toBe(409);
  });
});

describe("proving it is really you", () => {
  it("a code from the app upgrades the session; protected actions then work", async () => {
    const e = await enrolled();
    const blocked = await call("DELETE", "/v1/auth/mfa/totp", e.accessToken);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail).toMatch(/two-step verification/i);

    const verified = await call("POST", "/v1/auth/mfa/verify", e.accessToken, {
      code: codeFor(e.secret, 1),
    });
    expect(verified.statusCode).toBe(200);
    const { accessToken, refreshToken } = verified.json();
    expect(decodeJwt(accessToken).amr).toContain("mfa");

    // A refreshed token keeps the upgrade.
    const refreshed = await api.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(decodeJwt(refreshed.json().accessToken).amr).toContain("mfa");

    expect((await call("DELETE", "/v1/auth/mfa/totp", accessToken)).statusCode).toBe(204);
    expect((await call("GET", "/v1/auth/mfa", accessToken)).json().totpEnabled).toBe(false);
  });

  it("the same code cannot be used twice", async () => {
    const e = await enrolled();
    const code = codeFor(e.secret, 1);
    expect((await call("POST", "/v1/auth/mfa/verify", e.accessToken, { code })).statusCode).toBe(
      200,
    );
    expect((await call("POST", "/v1/auth/mfa/verify", e.accessToken, { code })).statusCode).toBe(
      400,
    );
  });

  it("a recovery code works exactly once", async () => {
    const e = await enrolled();
    const [recoveryCode] = e.confirm.json().recoveryCodes as string[];
    expect(
      (await call("POST", "/v1/auth/mfa/verify", e.accessToken, { recoveryCode })).statusCode,
    ).toBe(200);
    expect(
      (await call("POST", "/v1/auth/mfa/verify", e.accessToken, { recoveryCode })).statusCode,
    ).toBe(400);
    expect((await call("GET", "/v1/auth/mfa", e.accessToken)).json().recoveryCodesLeft).toBe(9);
  });

  it("after 5 wrong codes the account is paused for a while", async () => {
    const e = await enrolled();
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (await call("POST", "/v1/auth/mfa/verify", e.accessToken, { code: "000000" })).statusCode,
      );
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(
      (await call("POST", "/v1/auth/mfa/verify", e.accessToken, { code: codeFor(e.secret) }))
        .statusCode,
    ).toBe(429);
  });

  it("verifying without two-step turned on is refused", async () => {
    const s = await signedInUser();
    expect(
      (await call("POST", "/v1/auth/mfa/verify", s.accessToken, { code: "123456" })).statusCode,
    ).toBe(400);
  });
});
