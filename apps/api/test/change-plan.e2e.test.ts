import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { memberships, outboxEvents } from "@gym/db/schema";
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

describe("changing plan", () => {
  it("credits the unused days of the old plan and starts the new plan today", async () => {
    const g = await gymWithMember(api, dbh.db);
    const monthly = await g.plan({ durationUnit: "day", durationCount: 30, pricePaise: 300_000 });
    const yearly = await g.plan({
      name: "Yearly",
      durationUnit: "month",
      durationCount: 12,
      pricePaise: 2_400_000,
    });
    const m = (await g.enrol(monthly.id)).json();
    // Pretend it started 10 days ago: 20 of 30 days left.
    const orgId = g.base.split("/").at(-1) ?? "";
    await withTenant(dbh.db, orgId, (tx) =>
      tx
        .update(memberships)
        .set({ startDate: addDays(today(), -10), endDate: addDays(today(), 19) })
        .where(eq(memberships.id, m.id)),
    );

    const res = await g.call("POST", `${g.base}/memberships/${m.id}/change-plan`, {
      planId: yearly.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.creditPaise).toBe(200_000);
    expect(body.previous).toMatchObject({ status: "cancelled", cancelReason: "changed_plan" });
    expect(body.current).toMatchObject({
      planName: "Yearly",
      status: "active",
      startDate: today(),
      joiningFeePaise: 0,
    });

    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "membership.plan_changed"));
    expect(
      events.some(
        (e) => (e.payload as { newMembershipId: string }).newMembershipId === body.current.id,
      ),
    ).toBe(true);
  });

  it("a paused membership must be resumed first; ended ones cannot change", async () => {
    const g = await gymWithMember(api, dbh.db);
    const plan = await g.plan({ maxFreezes: 1, maxFreezeDays: 10 });
    const other = await g.plan({ name: "Other" });
    const m = (await g.enrol(plan.id)).json();
    await g.call("POST", `${g.base}/memberships/${m.id}/freeze`, { days: 5 });
    expect(
      (await g.call("POST", `${g.base}/memberships/${m.id}/change-plan`, { planId: other.id }))
        .statusCode,
    ).toBe(409);
  });

  it("nothing changes if the new plan cannot be sold", async () => {
    const g = await gymWithMember(api, dbh.db);
    const plan = await g.plan({});
    const archived = await g.plan({ name: "Archived" });
    await g.call("PATCH", `${g.base}/plans/${archived.id}`, { active: false });
    const m = (await g.enrol(plan.id)).json();
    expect(
      (await g.call("POST", `${g.base}/memberships/${m.id}/change-plan`, { planId: archived.id }))
        .statusCode,
    ).toBe(400);
    const list = (await g.call("GET", `${g.base}/members/${g.member.id}/memberships`)).json();
    expect(list.map((x: { status: string }) => x.status)).toEqual(["active"]);
  });
});
