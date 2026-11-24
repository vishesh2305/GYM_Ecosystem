import { createDb, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { outboxEvents } from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
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
const today = () => todayIn("Asia/Kolkata");

async function gymWithMember() {
  const owner = await signedInStaff(api, dbh.db);
  const res = (
    await req("POST", "/v1/orgs", owner.headers, {
      name: "Enrol Gym",
      branch: { name: "Main", city: "Pune" },
    })
  ).json();
  const base = `/v1/orgs/${res.organisation.id}`;
  const plan = async (body: object) =>
    (
      await req("POST", `${base}/plans`, owner.headers, {
        name: "Monthly",
        durationUnit: "month",
        durationCount: 1,
        pricePaise: 150_000,
        joiningFeePaise: 50_000,
        ...body,
      })
    ).json();
  const member = (
    await req("POST", `${base}/members`, owner.headers, {
      name: "Member",
      homeBranchId: res.branch.id,
    })
  ).json();
  const enrol = (planId: string, startDate?: string) =>
    req("POST", `${base}/members/${member.id}/memberships`, owner.headers, {
      planId,
      ...(startDate && { startDate }),
    });
  return { owner, base, branch: res.branch, member, plan, enrol };
}

describe("signing a member up", () => {
  it("starts today, ends a month later, and charges the joining fee the first time", async () => {
    const g = await gymWithMember();
    const monthly = await g.plan({});
    const res = await g.enrol(monthly.id);
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({
      status: "active",
      startDate: today(),
      planName: "Monthly",
      joiningFeePaise: 50_000,
      gstPaise: 36_000,
      totalPaise: 236_000,
    });
    expect(m.endDate > today()).toBe(true);

    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "membership.created"));
    expect(events.some((e) => (e.payload as { membershipId: string }).membershipId === m.id)).toBe(
      true,
    );
  });

  it("a renewal starts after the current membership, waits as 'pending' and has no joining fee", async () => {
    const g = await gymWithMember();
    const monthly = await g.plan({});
    const first = (await g.enrol(monthly.id)).json();
    const renewal = await g.enrol(monthly.id, addDays(first.endDate, 1));
    expect(renewal.statusCode).toBe(201);
    expect(renewal.json()).toMatchObject({
      status: "pending",
      joiningFeePaise: 0,
      totalPaise: 177_000,
    });

    const list = (
      await req("GET", `${g.base}/members/${g.member.id}/memberships`, g.owner.headers)
    ).json();
    expect(list.map((x: { status: string }) => x.status)).toEqual(["pending", "active"]);
  });

  it("refuses overlapping memberships, past start dates, archived plans and plans not sold at the member's branch", async () => {
    const g = await gymWithMember();
    const monthly = await g.plan({});
    await g.enrol(monthly.id);
    expect((await g.enrol(monthly.id, addDays(today(), 3))).statusCode).toBe(409);
    expect((await g.enrol(monthly.id, addDays(today(), -1))).statusCode).toBe(400);

    const archived = await g.plan({ name: "Old" });
    await req("PATCH", `${g.base}/plans/${archived.id}`, g.owner.headers, { active: false });
    expect((await g.enrol(archived.id, "2030-01-01")).statusCode).toBe(400);

    const other = (
      await req("POST", `${g.base}/branches`, g.owner.headers, { name: "Other", city: "Pune" })
    ).json();
    const elsewhere = await g.plan({ name: "Elsewhere", branchIds: [other.id] });
    expect((await g.enrol(elsewhere.id, "2030-01-01")).statusCode).toBe(400);
  });

  it("a trial plan starts as a trial", async () => {
    const g = await gymWithMember();
    const trial = await g.plan({
      name: "7-day trial",
      durationUnit: "day",
      durationCount: 7,
      pricePaise: 0,
      joiningFeePaise: 0,
      isTrial: true,
    });
    const m = (await g.enrol(trial.id)).json();
    expect(m).toMatchObject({ status: "trial", endDate: addDays(today(), 6), totalPaise: 0 });
  });
});
