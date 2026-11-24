import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { membershipFreezes } from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { gymWithMember, testEnv } from "./helpers";

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

const today = () => todayIn("Asia/Kolkata");

async function activeMembership(planBody: object = { maxFreezes: 2, maxFreezeDays: 30 }) {
  const g = await gymWithMember(api, dbh.db);
  const plan = await g.plan(planBody);
  const m = (await g.enrol(plan.id)).json();
  const act = (action: "freeze" | "unfreeze", payload?: object) =>
    g.call("POST", `${g.base}/memberships/${m.id}/${action}`, payload);
  return { g, m, act, orgId: g.base.split("/").at(-1) ?? "" };
}

describe("pausing a membership", () => {
  it("moves the end date back by the paused days", async () => {
    const { m, act } = await activeMembership();
    const res = await act("freeze", { days: 10, reason: "Travelling" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "frozen",
      endDate: addDays(m.endDate, 10),
      freezesUsed: 1,
    });
  });

  it("coming back early takes the unused days off again", async () => {
    const { m, act, orgId } = await activeMembership();
    await act("freeze", { days: 10 });
    // Pretend the pause started 3 days ago.
    await withTenant(dbh.db, orgId, (tx) =>
      tx
        .update(membershipFreezes)
        .set({ startsOn: addDays(today(), -3) })
        .where(eq(membershipFreezes.membershipId, m.id)),
    );
    const back = (await act("unfreeze")).json();
    expect(back).toMatchObject({
      status: "active",
      endDate: addDays(m.endDate, 3),
      freezesUsed: 1,
    });
  });

  it("undoing a pause on the same day restores everything, including the pause allowance", async () => {
    const { m, act } = await activeMembership();
    await act("freeze", { days: 10 });
    expect((await act("unfreeze")).json()).toMatchObject({
      status: "active",
      endDate: m.endDate,
      freezesUsed: 0,
    });
  });

  it("respects the plan's limits", async () => {
    const none = await activeMembership({ maxFreezes: 0, maxFreezeDays: 0 });
    expect((await none.act("freeze", { days: 5 })).json().detail).toMatch(/does not allow pausing/);

    const limited = await activeMembership({ maxFreezes: 1, maxFreezeDays: 7 });
    expect((await limited.act("freeze", { days: 8 })).statusCode).toBe(400);
    await limited.act("freeze", { days: 7 });
    await withTenant(dbh.db, limited.orgId, (tx) =>
      tx
        .update(membershipFreezes)
        .set({ startsOn: addDays(today(), -1) })
        .where(eq(membershipFreezes.membershipId, limited.m.id)),
    );
    await limited.act("unfreeze");
    expect((await limited.act("freeze", { days: 1 })).json().detail).toMatch(/used all 1 pauses/);
  });

  it("only active memberships can be paused, and only paused ones unpaused", async () => {
    const { act } = await activeMembership();
    expect((await act("unfreeze")).statusCode).toBe(409);
    await act("freeze", { days: 5 });
    expect((await act("freeze", { days: 5 })).statusCode).toBe(409);

    const g = await gymWithMember(api, dbh.db);
    const plan = await g.plan({ maxFreezes: 2, maxFreezeDays: 30 });
    const later = (await g.enrol(plan.id, addDays(today(), 10))).json();
    expect(
      (await g.call("POST", `${g.base}/memberships/${later.id}/freeze`, { days: 3 })).statusCode,
    ).toBe(409);
  });
});
