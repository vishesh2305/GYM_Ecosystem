import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { branches, organisations, staffMembers, users, type StaffRole } from "./schema";
import { withTenant } from "./tenant";

/** Fixed ids and phone numbers, so the demo data can be re-created and referred to in docs. */
export const DEMO = {
  orgId: "01930000-0000-7000-8000-000000000001",
  branchIds: [
    "01930000-0000-7000-8000-000000000011",
    "01930000-0000-7000-8000-000000000012",
  ] as const,
  staff: [
    {
      id: "01930000-0000-7000-8000-000000000101",
      name: "Demo Owner",
      phone: "+919900000001",
      role: "owner",
    },
    {
      id: "01930000-0000-7000-8000-000000000102",
      name: "Demo Manager",
      phone: "+919900000002",
      role: "manager",
    },
    {
      id: "01930000-0000-7000-8000-000000000103",
      name: "Demo Front Desk",
      phone: "+919900000003",
      role: "front_desk",
    },
    {
      id: "01930000-0000-7000-8000-000000000104",
      name: "Demo Trainer",
      phone: "+919900000004",
      role: "trainer",
    },
  ] satisfies { id: string; name: string; phone: string; role: StaffRole }[],
};

/** Local development data. Safe to run repeatedly: existing rows are left as they are. */
export async function seed(db: Database): Promise<void> {
  await db
    .insert(users)
    .values(
      DEMO.staff.map((s) => ({
        id: s.id,
        name: s.name,
        phone: s.phone,
        phoneVerifiedAt: sql`now()`,
      })),
    )
    .onConflictDoNothing();

  await withTenant(db, DEMO.orgId, async (tx) => {
    await tx
      .insert(organisations)
      .values({
        id: DEMO.orgId,
        name: "Demo Fitness",
        gstin: "27AAPFU0939F1ZV",
        createdBy: DEMO.staff[0]?.id,
      })
      .onConflictDoNothing();
    await tx
      .insert(branches)
      .values([
        {
          id: DEMO.branchIds[0],
          tenantId: DEMO.orgId,
          name: "Koregaon Park",
          city: "Pune",
          state: "Maharashtra",
        },
        {
          id: DEMO.branchIds[1],
          tenantId: DEMO.orgId,
          name: "Baner",
          city: "Pune",
          state: "Maharashtra",
        },
      ])
      .onConflictDoNothing();
    await tx
      .insert(staffMembers)
      .values(
        DEMO.staff.map((s) => ({
          tenantId: DEMO.orgId,
          userId: s.id,
          role: s.role,
          // The demo manager runs one branch, to show branch-limited access.
          branchIds: s.role === "manager" ? [DEMO.branchIds[0]] : [],
        })),
      )
      .onConflictDoNothing();
  });
}
