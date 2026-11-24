import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { createDb, type DbHandle } from "./client";
import { branches, members, memberships, plans, staffMembers, users } from "./schema";
import { DEMO, seed } from "./seed";
import { withTenant } from "./tenant";
import { inArray } from "drizzle-orm";

let handle: DbHandle;
beforeAll(() => {
  handle = createDb(inject("databaseUrl"));
});
afterAll(async () => {
  await handle.pool.end();
});

describe("demo data", () => {
  it("creates a demo gym with two branches and four staff, and can be run again safely", async () => {
    await seed(handle.db);
    await seed(handle.db);
    const [branchRows, staff] = await withTenant(handle.db, DEMO.orgId, (tx) =>
      Promise.all([tx.select().from(branches), tx.select().from(staffMembers)]),
    );
    expect(branchRows.map((b) => b.name).sort()).toEqual(["Baner", "Koregaon Park"]);
    expect(staff.map((s) => s.role).sort()).toEqual(["front_desk", "manager", "owner", "trainer"]);
    expect(staff.find((s) => s.role === "manager")?.branchIds).toEqual([DEMO.branchIds[0]]);
    const people = await handle.db
      .select()
      .from(users)
      .where(
        inArray(
          users.phone,
          DEMO.staff.map((s) => s.phone),
        ),
      );
    expect(people).toHaveLength(4);
    expect(people.every((p) => p.phoneVerifiedAt)).toBe(true);

    const [planRows, memberRows, membershipRows] = await withTenant(handle.db, DEMO.orgId, (tx) =>
      Promise.all([
        tx.select().from(plans),
        tx.select().from(members),
        tx.select().from(memberships),
      ]),
    );
    expect(planRows.map((p) => p.name).sort()).toEqual([
      "7-day trial",
      "Monthly",
      "Quarterly",
      "Yearly",
    ]);
    expect(memberRows).toHaveLength(200);
    expect(membershipRows).toHaveLength(180);
    expect(membershipRows.filter((m) => m.status === "active").length).toBeGreaterThan(100);
    expect(membershipRows.some((m) => m.status === "expired")).toBe(true);
  });
});
