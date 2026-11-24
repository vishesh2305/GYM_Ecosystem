import { createDb, type DbHandle } from "@gym/db";
import { users } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SessionService } from "../src/auth/session.service";
import { randomIp, testEnv } from "./helpers";
import { TestModule, testState } from "./test.module";

let dbh: DbHandle;
beforeAll(() => {
  dbh = createDb(testEnv().DATABASE_URL);
});
afterAll(async () => {
  await dbh.pool.end();
});

async function tokenFor(app: Awaited<ReturnType<typeof createApp>>["app"]) {
  const [user] = await dbh.db.insert(users).values({ name: "limits" }).returning();
  if (!user) throw new Error("insert failed");
  return (await app.get(SessionService).createSession(user.id, { amr: ["otp"] })).accessToken;
}

describe("retry protection is per person, not per network", () => {
  it("the same key from two people runs twice; the same person on two networks gets a replay", async () => {
    const { app } = await createApp(testEnv(), { modules: [TestModule] });
    try {
      const charge = (token: string, ip: string) =>
        app.inject({
          method: "POST",
          url: "/v1/_test/charge",
          headers: { authorization: `Bearer ${token}`, "idempotency-key": "shared-key-1" },
          payload: { amount: 100 },
          remoteAddress: ip,
        });
      const asha = await tokenFor(app);
      const ravi = await tokenFor(app);
      const before = testState.charges;
      const a1 = await charge(asha, randomIp());
      const a2 = await charge(asha, randomIp()); // moved from Wi-Fi to mobile data
      const r1 = await charge(ravi, randomIp());
      expect(a2.headers["idempotent-replayed"]).toBe("true");
      expect(a2.json()).toEqual(a1.json());
      expect(r1.headers["idempotent-replayed"]).toBeUndefined();
      expect(testState.charges - before).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe("request limits are per person when signed in", () => {
  it("one person cannot dodge the limit by switching networks, and does not use up a shared network's limit", async () => {
    const { app } = await createApp(testEnv({ RATE_LIMIT_MAX: "3" }));
    try {
      const me = (token: string, ip: string) =>
        app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${token}` },
          remoteAddress: ip,
        });
      const heavy = await tokenFor(app);
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await me(heavy, randomIp())).statusCode);
      expect(statuses).toEqual([200, 200, 200, 429]);

      const sharedIp = randomIp();
      const neighbour = await tokenFor(app);
      for (let i = 0; i < 3; i++) await me(await tokenFor(app), sharedIp);
      expect((await me(neighbour, sharedIp)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
