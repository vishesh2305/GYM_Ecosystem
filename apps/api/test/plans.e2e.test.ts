import { createDb, type DbHandle } from "@gym/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ConsoleSmsSender } from "../src/auth/senders";
import { SMS_SENDER } from "../src/tokens";
import { signedInStaff, testEnv } from "./helpers";

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

type Headers = Record<string, string>;
const req = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  api.inject({ method, url, headers, ...(payload && { payload }) });

const monthly = {
  name: "Monthly",
  durationUnit: "month",
  durationCount: 1,
  pricePaise: 150_000,
  joiningFeePaise: 50_000,
};

async function gym() {
  const owner = await signedInStaff(api, dbh.db);
  const res = (
    await req("POST", "/v1/orgs", owner.headers, {
      name: "Plan Gym",
      branch: { name: "Main", city: "Pune" },
    })
  ).json();
  return { owner, base: `/v1/orgs/${res.organisation.id}`, branch: res.branch };
}

describe("membership plans", () => {
  it("an owner creates a plan; the price with GST is worked out", async () => {
    const g = await gym();
    const res = await req("POST", `${g.base}/plans`, g.owner.headers, monthly);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: "Monthly",
      gstRateBps: 1800,
      pricePaise: 150_000,
      joiningFeePaise: 50_000,
      gstPaise: 36_000,
      totalPaise: 236_000,
      active: true,
    });
  });

  it("rejects impossible plans", async () => {
    const g = await gym();
    for (const bad of [
      { ...monthly, durationCount: 37 },
      { ...monthly, pricePaise: -1 },
      { ...monthly, gstRateBps: 1700 },
      { ...monthly, durationUnit: "year" },
    ]) {
      expect((await req("POST", `${g.base}/plans`, g.owner.headers, bad)).statusCode).toBe(400);
    }
  });

  it("archived plans disappear from the normal list but stay available on request", async () => {
    const g = await gym();
    const planId = (await req("POST", `${g.base}/plans`, g.owner.headers, monthly)).json().id;
    const archived = await req("PATCH", `${g.base}/plans/${planId}`, g.owner.headers, {
      active: false,
      pricePaise: 160_000,
    });
    expect(archived.json()).toMatchObject({ active: false, pricePaise: 160_000 });
    expect((await req("GET", `${g.base}/plans`, g.owner.headers)).json()).toHaveLength(0);
    expect(
      (await req("GET", `${g.base}/plans?includeArchived=true`, g.owner.headers)).json(),
    ).toHaveLength(1);
  });

  it("plans for one branch are only seen and managed by staff of that branch", async () => {
    const g = await gym();
    const other = (
      await req("POST", `${g.base}/branches`, g.owner.headers, { name: "Other", city: "Pune" })
    ).json();
    const mainOnly = (
      await req("POST", `${g.base}/plans`, g.owner.headers, {
        ...monthly,
        branchIds: [g.branch.id],
      })
    ).json();
    const otherOnly = (
      await req("POST", `${g.base}/plans`, g.owner.headers, {
        ...monthly,
        name: "Other only",
        branchIds: [other.id],
      })
    ).json();

    const sms = api.get<ConsoleSmsSender>(SMS_SENDER);
    const phone = `+9195${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    await req("POST", `${g.base}/invites`, g.owner.headers, {
      channel: "sms",
      phone,
      role: "manager",
      branchIds: [g.branch.id],
    });
    const manager = await signedInStaff(api, dbh.db, { phone });
    await req("POST", "/v1/invites/accept", manager.headers, {
      token: /\/invite\/([\w.-]+)/.exec(sms.sent.at(-1)?.text ?? "")?.[1],
    });

    const seen = (await req("GET", `${g.base}/plans`, manager.headers)).json() as { id: string }[];
    expect(seen.map((p) => p.id)).toEqual([mainOnly.id]);
    expect(
      (await req("PATCH", `${g.base}/plans/${otherOnly.id}`, manager.headers, { pricePaise: 1 }))
        .statusCode,
    ).toBe(404);
    expect(
      (await req("POST", `${g.base}/plans`, manager.headers, { ...monthly, branchIds: [other.id] }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await req("POST", `${g.base}/plans`, manager.headers, {
          ...monthly,
          branchIds: [g.branch.id],
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe("editing a plan", () => {
  it("changes only the fields that were sent", async () => {
    const g = await gym();
    const created = (
      await req("POST", `${g.base}/plans`, g.owner.headers, {
        ...monthly,
        gstRateBps: 500,
        maxFreezes: 2,
        branchIds: [g.branch.id],
      })
    ).json();
    const edited = (
      await req("PATCH", `${g.base}/plans/${created.id}`, g.owner.headers, { pricePaise: 170_000 })
    ).json();
    expect(edited).toMatchObject({
      pricePaise: 170_000,
      gstRateBps: 500,
      joiningFeePaise: 50_000,
      maxFreezes: 2,
      branchIds: [g.branch.id],
    });
  });
});
