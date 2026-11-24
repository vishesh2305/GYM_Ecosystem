import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { v7 } from "uuid";
import { eq } from "drizzle-orm";
import { createDb, type DbHandle } from "./client";
import { branches, organisations, staffMembers, users } from "./schema";
import { withTenant, withUser } from "./tenant";

let handle: DbHandle;
const orgA = v7();
const orgB = v7();
let alice: string; // staff at A
let bob: string; // staff at B
let carol: string; // staff at both
let dave: string; // suspended at A

async function newUser(name: string) {
  const [u] = await handle.db.insert(users).values({ name }).returning();
  if (!u) throw new Error("insert failed");
  return u.id;
}

beforeAll(async () => {
  handle = createDb(inject("databaseUrl"));
  [alice, bob, carol, dave] = (await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(newUser),
  )) as [string, string, string, string];
  for (const [org, name, staff] of [
    [
      orgA,
      "Alpha Gym",
      [
        [alice, "active"],
        [carol, "active"],
        [dave, "suspended"],
      ],
    ],
    [
      orgB,
      "Beta Gym",
      [
        [bob, "active"],
        [carol, "active"],
      ],
    ],
  ] as const) {
    await withTenant(handle.db, org, async (tx) => {
      await tx.insert(organisations).values({ id: org, name });
      await tx.insert(branches).values({ tenantId: org, name: `${name} Main`, city: "Pune" });
      for (const [userId, status] of staff) {
        await tx.insert(staffMembers).values({ tenantId: org, userId, role: "owner", status });
      }
    });
  }
});
afterAll(async () => {
  await handle.pool.end();
});

describe("person scope (withUser)", () => {
  it("shows only my own memberships and the organisations I actively work at", async () => {
    const mine = await withUser(handle.db, alice, (tx) => tx.select().from(staffMembers));
    expect(mine.map((m) => m.userId)).toEqual([alice]);
    const orgs = await withUser(handle.db, alice, (tx) => tx.select().from(organisations));
    expect(orgs.map((o) => o.name)).toEqual(["Alpha Gym"]);
  });

  it("someone at two gyms sees both", async () => {
    const orgs = await withUser(handle.db, carol, (tx) => tx.select().from(organisations));
    expect(orgs.map((o) => o.name).sort()).toEqual(["Alpha Gym", "Beta Gym"]);
  });

  it("a suspended person no longer sees the organisation", async () => {
    const orgs = await withUser(handle.db, dave, (tx) => tx.select().from(organisations));
    expect(orgs).toEqual([]);
  });

  it("rejects a user id that is not a UUID", async () => {
    await expect(withUser(handle.db, "1 or 1=1", async () => 1)).rejects.toThrow(TypeError);
  });

  it("cannot read another tenant's branches", async () => {
    const seen = await withUser(handle.db, alice, (tx) => tx.select().from(branches));
    expect(seen).toEqual([]);
  });
});

describe("tenant scope (withTenant)", () => {
  it("sees only its own organisation, branches and staff", async () => {
    const [orgs, branchRows, staff] = await withTenant(handle.db, orgA, (tx) =>
      Promise.all([
        tx.select().from(organisations),
        tx.select().from(branches),
        tx.select().from(staffMembers),
      ]),
    );
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
    expect(branchRows.every((b) => b.tenantId === orgA)).toBe(true);
    expect(staff.every((s) => s.tenantId === orgA)).toBe(true);
  });

  it("cannot write into another tenant or change another tenant's organisation", async () => {
    await expect(
      withTenant(handle.db, orgA, (tx) =>
        tx.insert(branches).values({ tenantId: orgB, name: "Sneaky", city: "X" }),
      ),
    ).rejects.toThrow();
    const changed = await withTenant(handle.db, orgA, (tx) =>
      tx
        .update(organisations)
        .set({ name: "Hacked" })
        .where(eq(organisations.id, orgB))
        .returning(),
    );
    expect(changed).toEqual([]);
  });
});
