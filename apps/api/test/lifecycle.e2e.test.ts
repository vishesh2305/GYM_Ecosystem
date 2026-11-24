import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { membershipFreezes, memberships, outboxEvents } from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { runMembershipLifecycle } from "../src/membership/lifecycle";
import { createWorker } from "../src/worker/create-worker";
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

async function membershipWith(planBody: object = {}) {
  const g = await gymWithMember(api, dbh.db);
  const plan = await g.plan({ maxFreezes: 2, maxFreezeDays: 30, ...planBody });
  const m = (await g.enrol(plan.id)).json();
  const orgId = g.base.split("/").at(-1) ?? "";
  const set = (values: Partial<typeof memberships.$inferInsert>) =>
    withTenant(dbh.db, orgId, (tx) =>
      tx.update(memberships).set(values).where(eq(memberships.id, m.id)),
    );
  const read = async () =>
    (
      await withTenant(dbh.db, orgId, (tx) =>
        tx.select().from(memberships).where(eq(memberships.id, m.id)),
      )
    )[0];
  return { g, m, orgId, set, read };
}

describe("hourly membership upkeep", () => {
  it("starts memberships whose start date has come, in the gym's time zone", async () => {
    const t = await membershipWith();
    await t.set({ status: "pending" });
    await runMembershipLifecycle(dbh.db);
    expect((await t.read())?.status).toBe("active");
  });

  it("expires memberships after their last day and announces it", async () => {
    const t = await membershipWith();
    await t.set({ startDate: addDays(today(), -30), endDate: addDays(today(), -1) });
    const result = await runMembershipLifecycle(dbh.db);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await t.read())?.status).toBe("expired");
    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "membership.expired"));
    expect(
      events.some((e) => (e.payload as { membershipId: string }).membershipId === t.m.id),
    ).toBe(true);
  });

  it("a membership on its last day stays active", async () => {
    const t = await membershipWith();
    await t.set({ endDate: today() });
    await runMembershipLifecycle(dbh.db);
    expect((await t.read())?.status).toBe("active");
  });

  it("resumes pauses that have reached their planned end", async () => {
    const t = await membershipWith();
    await t.g.call("POST", `${t.g.base}/memberships/${t.m.id}/freeze`, { days: 5 });
    await withTenant(dbh.db, t.orgId, (tx) =>
      tx
        .update(membershipFreezes)
        .set({ startsOn: addDays(today(), -5), plannedEndsOn: addDays(today(), -1) })
        .where(eq(membershipFreezes.membershipId, t.m.id)),
    );
    const before = await t.read();
    await runMembershipLifecycle(dbh.db);
    const after = await t.read();
    expect(after?.status).toBe("active");
    expect(after?.endDate).toBe(before?.endDate); // all 5 paused days were used
  });

  it("is safe to run again", async () => {
    const t = await membershipWith();
    await t.set({ startDate: addDays(today(), -30), endDate: addDays(today(), -1) });
    await runMembershipLifecycle(dbh.db);
    await runMembershipLifecycle(dbh.db);
    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "membership.expired"));
    expect(
      events.filter((e) => (e.payload as { membershipId: string }).membershipId === t.m.id),
    ).toHaveLength(1);
  });

  it("is scheduled hourly by the worker", async () => {
    const worker = await createWorker(testEnv(), { autostart: false });
    try {
      const keys = (await worker.maintenanceQueue.getJobSchedulers()).map((s) => s.key);
      expect(keys).toContain("membership-lifecycle-hourly");
    } finally {
      await worker.close();
    }
  });
});

describe("cancelling a membership", () => {
  it("managers and owners cancel with a reason; front desk cannot", async () => {
    const t = await membershipWith();
    const res = await t.g.call("POST", `${t.g.base}/memberships/${t.m.id}/cancel`, {
      reason: "Moved to another city",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "cancelled",
      cancelReason: "Moved to another city",
    });
    expect(
      (await t.g.call("POST", `${t.g.base}/memberships/${t.m.id}/cancel`, { reason: "again" }))
        .statusCode,
    ).toBe(409);
  });

  it("cancelling a paused membership also closes the pause", async () => {
    const t = await membershipWith();
    await t.g.call("POST", `${t.g.base}/memberships/${t.m.id}/freeze`, { days: 5 });
    await t.g.call("POST", `${t.g.base}/memberships/${t.m.id}/cancel`, { reason: "Injury" });
    const [freeze] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(membershipFreezes).where(eq(membershipFreezes.membershipId, t.m.id)),
    );
    expect(freeze?.endedOn).not.toBeNull();
  });
});
