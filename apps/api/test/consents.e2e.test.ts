import { createDb, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { consents, users } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SessionService } from "../src/auth/session.service";
import { testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

async function member() {
  const [user] = await dbh.db.insert(users).values({ name: "Consent tester" }).returning();
  if (!user) throw new Error("insert failed");
  const { accessToken } = await api.get(SessionService).createSession(user.id, { amr: ["otp"] });
  const headers = { authorization: `Bearer ${accessToken}` };
  return {
    user,
    decide: (purpose: string, granted: boolean, policyVersion = "2026-11") =>
      api.inject({
        method: "POST",
        url: "/v1/me/consents",
        headers,
        payload: { purpose, granted, policyVersion },
      }),
    current: () => api.inject({ method: "GET", url: "/v1/me/consents", headers }),
  };
}

describe("privacy and marketing choices", () => {
  it("records each decision and shows the latest one per purpose", async () => {
    const m = await member();
    expect((await m.decide("terms", true)).statusCode).toBe(201);
    expect((await m.decide("marketing_whatsapp", true)).statusCode).toBe(201);
    expect((await m.decide("marketing_whatsapp", false, "2026-12")).statusCode).toBe(201);

    const state = (await m.current()).json() as {
      purpose: string;
      granted: boolean;
      policyVersion: string;
    }[];
    expect(state.find((c) => c.purpose === "terms")).toMatchObject({
      granted: true,
      policyVersion: "2026-11",
    });
    expect(state.find((c) => c.purpose === "marketing_whatsapp")).toMatchObject({
      granted: false,
      policyVersion: "2026-12",
    });
  });

  it("keeps the full history: withdrawing adds a record instead of deleting one", async () => {
    const m = await member();
    await m.decide("health_data", true);
    await m.decide("health_data", false);
    const rows = await dbh.db.select().from(consents).where(eq(consents.userId, m.user.id));
    expect(rows.map((r) => r.granted)).toEqual([true, false]);
    expect(rows[0]?.ip).toBeTruthy();
  });

  it("rejects unknown purposes and requires sign-in", async () => {
    const m = await member();
    expect((await m.decide("sell_my_data", true)).statusCode).toBe(400);
    expect((await api.inject({ method: "GET", url: "/v1/me/consents" })).statusCode).toBe(401);
  });
});
