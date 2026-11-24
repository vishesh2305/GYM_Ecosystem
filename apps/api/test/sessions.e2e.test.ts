import { createDb, type DbHandle } from "@gym/db";
import { auditLog, sessions, users } from "@gym/db/schema";
import { eq } from "@gym/db/orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionService } from "../src/auth/session.service";
import { createApp } from "../src/app";
import { testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let sessionsSvc: SessionService;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function newUser(name = "Asha") {
  const [user] = await dbh.db
    .insert(users)
    .values({ name, phone: `+9198${Math.floor(Math.random() * 1e8)}` })
    .returning();
  if (!user) throw new Error("insert failed");
  return user;
}

const signIn = async (userId: string, deviceName = "Pixel 9") =>
  sessionsSvc.createSession(userId, {
    amr: ["otp"],
    deviceName,
    userAgent: "test",
    ip: "127.0.0.1",
  });

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  sessionsSvc = api.get(SessionService);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

describe("every endpoint is locked unless marked public", () => {
  it("401 problem with WWW-Authenticate when no token is sent", async () => {
    const res = await api.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("401 for a malformed, forged or wrongly signed token", async () => {
    const forgedKey = await createApp(
      testEnv({
        JWT_PRIVATE_JWK: JSON.stringify(
          (await import("node:crypto"))
            .generateKeyPairSync("ed25519")
            .privateKey.export({ format: "jwk" }),
        ),
      }),
    );
    const user = await newUser();
    const foreign = await forgedKey.app
      .get(SessionService)
      .createSession(user.id, { amr: ["otp"] });
    await forgedKey.app.close();
    for (const token of ["garbage", "a.b.c", foreign.accessToken]) {
      expect(
        (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(token) })).statusCode,
      ).toBe(401);
    }
  });

  it("401 once the access token has expired", async () => {
    const shortLived = await createApp(testEnv({ ACCESS_TOKEN_TTL_SECONDS: "1" }));
    try {
      const user = await newUser();
      const { accessToken } = await shortLived.app
        .get(SessionService)
        .createSession(user.id, { amr: ["otp"] });
      await new Promise((r) => setTimeout(r, 2100));
      const res = await shortLived.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await shortLived.app.close();
    }
  });

  it("public endpoints stay open", async () => {
    expect((await api.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(200);
  });
});

describe("my profile", () => {
  it("returns and updates the signed-in user's profile", async () => {
    const user = await newUser("Ravi");
    const { accessToken } = await signIn(user.id);
    const me = await api.inject({ method: "GET", url: "/v1/me", headers: bearer(accessToken) });
    expect(me.json()).toMatchObject({ id: user.id, name: "Ravi", phone: user.phone, email: null });

    const patched = await api.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(accessToken),
      payload: { name: "Ravi K" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe("Ravi K");
    const bad = await api.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(accessToken),
      payload: { name: "" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("refresh tokens", () => {
  const refresh = (refreshToken: string) =>
    api.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });

  it("rotate: each refresh returns a new pair and the new access token works", async () => {
    const user = await newUser();
    const first = await signIn(user.id);
    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(next).toMatchObject({ tokenType: "Bearer", expiresIn: 900 });
    expect(
      (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(next.accessToken) }))
        .statusCode,
    ).toBe(200);
  });

  it("reusing an old refresh token ends the whole session (stolen-token defence)", async () => {
    const user = await newUser();
    const first = await signIn(user.id);
    const second = (await refresh(first.refreshToken)).json();

    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect((await refresh(second.refreshToken)).statusCode).toBe(401);
    expect(
      (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(second.accessToken) }))
        .statusCode,
    ).toBe(401);

    const [session] = await dbh.db.select().from(sessions).where(eq(sessions.id, first.sessionId));
    expect(session?.revokedReason).toBe("refresh_token_reuse");
    const audit = await dbh.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, first.sessionId));
    expect(audit.map((a) => a.action)).toContain("auth.refresh_token_reused");
  });

  it("rejects unknown and expired refresh tokens", async () => {
    expect((await refresh("not-a-real-token")).statusCode).toBe(401);
    const expiring = await createApp(testEnv({ REFRESH_TOKEN_TTL_DAYS: "0" }));
    try {
      const user = await newUser();
      const { refreshToken } = await expiring.app
        .get(SessionService)
        .createSession(user.id, { amr: ["otp"] });
      expect((await refresh(refreshToken)).statusCode).toBe(401);
    } finally {
      await expiring.app.close();
    }
  });
});

describe("sign out and devices", () => {
  it("sign out ends the session immediately", async () => {
    const user = await newUser();
    const s = await signIn(user.id);
    const out = await api.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: bearer(s.accessToken),
    });
    expect(out.statusCode).toBe(204);
    expect(
      (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(s.accessToken) }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await api.inject({
          method: "POST",
          url: "/v1/auth/refresh",
          payload: { refreshToken: s.refreshToken },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("lists my active devices and lets me sign one out; others' sessions are invisible", async () => {
    const me = await newUser();
    const phone = await signIn(me.id, "Pixel 9");
    const tablet = await signIn(me.id, "iPad");
    const stranger = await signIn((await newUser()).id, "Other");

    const list = await api.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: bearer(phone.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const devices = list.json() as { id: string; deviceName: string; current: boolean }[];
    expect(devices.map((d) => d.deviceName).sort()).toEqual(["Pixel 9", "iPad"]);
    expect(devices.find((d) => d.current)?.id).toBe(phone.sessionId);

    const del = (id: string) =>
      api.inject({
        method: "DELETE",
        url: `/v1/auth/sessions/${id}`,
        headers: bearer(phone.accessToken),
      });
    expect((await del(stranger.sessionId)).statusCode).toBe(404);
    expect((await del(tablet.sessionId)).statusCode).toBe(204);
    expect(
      (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(tablet.accessToken) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(stranger.accessToken) }))
        .statusCode,
    ).toBe(200);
  });

  it("sign out everywhere ends every session of the user", async () => {
    const me = await newUser();
    const a = await signIn(me.id);
    const b = await signIn(me.id);
    expect(
      (
        await api.inject({
          method: "POST",
          url: "/v1/auth/logout-all",
          headers: bearer(a.accessToken),
        })
      ).statusCode,
    ).toBe(204);
    for (const s of [a, b]) {
      expect(
        (await api.inject({ method: "GET", url: "/v1/me", headers: bearer(s.accessToken) }))
          .statusCode,
      ).toBe(401);
    }
  });

  it("still blocks a signed-out session when Redis is unavailable (database fallback)", async () => {
    const noRedis = await createApp(testEnv({ REDIS_URL: "redis://127.0.0.1:1" }));
    try {
      const me = await newUser();
      const s = await signIn(me.id);
      await sessionsSvc.revoke(s.sessionId, "signed_out");
      const res = await noRedis.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: bearer(s.accessToken),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await noRedis.app.close();
    }
  });
});
