import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { addDays, planEndDate, priceBreakdown, todayIn } from "@gym/domain";
import {
  branches,
  members,
  memberships,
  organisations,
  plans,
  staffMembers,
  users,
  type StaffRole,
} from "./schema";
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
  memberCount: 200,
};

const FIRST = [
  "Aarav",
  "Diya",
  "Kabir",
  "Ananya",
  "Vihaan",
  "Isha",
  "Arjun",
  "Meera",
  "Rohan",
  "Saanvi",
  "Aditya",
  "Kavya",
];
const LAST = [
  "Sharma",
  "Patel",
  "Iyer",
  "Reddy",
  "Kulkarni",
  "Singh",
  "Deshpande",
  "Nair",
  "Joshi",
  "Gupta",
];
const DEMO_PLANS = [
  {
    key: "monthly",
    name: "Monthly",
    durationUnit: "month",
    durationCount: 1,
    pricePaise: 150_000,
    joiningFeePaise: 50_000,
    maxFreezes: 1,
    maxFreezeDays: 7,
  },
  {
    key: "quarterly",
    name: "Quarterly",
    durationUnit: "month",
    durationCount: 3,
    pricePaise: 400_000,
    joiningFeePaise: 50_000,
    maxFreezes: 2,
    maxFreezeDays: 15,
  },
  {
    key: "yearly",
    name: "Yearly",
    durationUnit: "month",
    durationCount: 12,
    pricePaise: 1_400_000,
    joiningFeePaise: 0,
    maxFreezes: 4,
    maxFreezeDays: 30,
  },
  {
    key: "trial",
    name: "7-day trial",
    durationUnit: "day",
    durationCount: 7,
    pricePaise: 0,
    joiningFeePaise: 0,
    maxFreezes: 0,
    maxFreezeDays: 0,
    isTrial: true,
  },
] as const;

/** Fixed, readable ids: 01930000-0000-7000-8<kind>-<n padded to 12>. */
const demoId = (kind: number, n: number) =>
  `01930000-0000-7000-8${kind}${"0".repeat(2)}-${String(n).padStart(12, "0")}`;

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

    const planRows = DEMO_PLANS.map((p, i) => ({ ...p, id: demoId(2, i + 1) }));
    await tx
      .insert(plans)
      .values(
        planRows.map(({ key: _, ...p }) => ({ tenantId: DEMO.orgId, gstRateBps: 1800, ...p })),
      )
      .onConflictDoNothing();

    // 200 members: ~3 in 4 with a running membership, some expired, a few with none yet.
    const today = todayIn("Asia/Kolkata");
    const memberRows = Array.from({ length: DEMO.memberCount }, (_, i) => ({
      id: demoId(3, i + 1),
      tenantId: DEMO.orgId,
      name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
      phone: `+9199100${String(i + 1).padStart(5, "0")}`,
      homeBranchId: DEMO.branchIds[i % 2] as string,
      gender: i % 2 ? ("male" as const) : ("female" as const),
    }));
    await tx.insert(members).values(memberRows).onConflictDoNothing();

    const membershipRows = memberRows.flatMap((m, i) => {
      if (i % 10 === 9) return []; // no membership yet
      const plan = planRows[i % 3] as (typeof planRows)[number]; // monthly / quarterly / yearly
      const expired = i % 10 >= 7;
      const startDate = expired ? addDays(today, -120 - (i % 30)) : addDays(today, -(i % 25));
      const endDate = planEndDate(startDate, {
        unit: plan.durationUnit,
        count: plan.durationCount,
      });
      const price = priceBreakdown({
        pricePaise: plan.pricePaise,
        joiningFeePaise: plan.joiningFeePaise,
        gstRateBps: 1800,
      });
      return [
        {
          id: demoId(4, i + 1),
          tenantId: DEMO.orgId,
          memberId: m.id,
          planId: plan.id,
          planName: plan.name,
          status: endDate < today ? ("expired" as const) : ("active" as const),
          startDate,
          endDate,
          isTrial: false,
          pricePaise: price.pricePaise,
          joiningFeePaise: price.joiningFeePaise,
          gstRateBps: 1800,
          gstPaise: price.gstPaise,
          totalPaise: price.totalPaise,
          maxFreezes: plan.maxFreezes,
          maxFreezeDays: plan.maxFreezeDays,
        },
      ];
    });
    await tx.insert(memberships).values(membershipRows).onConflictDoNothing();
  });
}
