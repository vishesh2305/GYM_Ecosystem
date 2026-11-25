import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { checkIns, invoices, leads, memberships, payments, refunds } from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { issueMembershipInvoice } from "../src/billing/invoicing";
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

const IST = "Asia/Kolkata";
type Gym = Awaited<ReturnType<typeof gymWithMember>>;
const orgOf = (g: Gym) => g.base.split("/").pop() ?? "";
/** An instant given as a wall-clock time in India. */
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

async function newMember(g: Gym) {
  const res = await g.call("POST", `${g.base}/members`, {
    name: "Payer",
    homeBranchId: g.branch.id,
  });
  return (res.json() as { id: string }).id;
}

/** Sells a plan to a new member and issues the invoice now (the worker does this in production). */
async function invoiceFor(g: Gym, pricePaise: number) {
  const memberId = await newMember(g);
  const plan = await g.plan({ pricePaise, joiningFeePaise: 0, gstRateBps: 0 });
  const sold = await g.call("POST", `${g.base}/members/${memberId}/memberships`, {
    planId: plan.id,
  });
  expect(sold.statusCode).toBe(201);
  const membershipId = (sold.json() as { id: string }).id;
  return withTenant(dbh.db, orgOf(g), async (tx) => {
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId));
    if (!m) throw new Error("no membership");
    const invoice = await issueMembershipInvoice(tx, orgOf(g), { ...m, membershipId: m.id });
    if (!invoice) throw new Error("no invoice");
    return invoice;
  });
}

const pay = async (g: Gym, invoiceId: string, method: string, amountPaise: number) => {
  const res = await api.inject({
    method: "POST",
    url: `${g.base}/invoices/${invoiceId}/payments`,
    headers: { ...g.owner.headers, "idempotency-key": crypto.randomUUID() },
    payload: { method, amountPaise },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
};

const report = async (g: Gym, path: string) => {
  const res = await g.call("GET", `${g.base}/reports/${path}`);
  expect(res.statusCode, path).toBe(200);
  return res.json();
};

describe("revenue", () => {
  it("adds up payments and refunds per day in the gym's time zone, and by method", async () => {
    const g = await gymWithMember(api, dbh.db);
    const today = todayIn(IST);
    const invoice = await invoiceFor(g, 300_000);
    const cash = await pay(g, invoice.id, "cash", 100_000);
    const upi = await pay(g, invoice.id, "upi_qr", 80_000);
    const card = await pay(g, invoice.id, "card_terminal", 50_000);
    const refund = await api.inject({
      method: "POST",
      url: `${g.base}/payments/${cash.id}/refunds`,
      headers: { ...g.owner.headers, "idempotency-key": crypto.randomUUID() },
      payload: { amountPaise: 30_000, reason: "Charged twice" },
    });
    expect(refund.statusCode).toBe(201);

    // Fixture dates: UPI paid 3 days ago at 00:30 India time (still the day before in UTC), card 40 days ago.
    const threeDaysAgo = addDays(today, -3);
    await withTenant(dbh.db, orgOf(g), async (tx) => {
      await tx
        .update(payments)
        .set({ capturedAt: ist(today, "10:00") })
        .where(eq(payments.id, cash.id));
      await tx
        .update(payments)
        .set({ capturedAt: ist(threeDaysAgo, "00:30") })
        .where(eq(payments.id, upi.id));
      await tx
        .update(payments)
        .set({ capturedAt: ist(addDays(today, -40), "12:00") })
        .where(eq(payments.id, card.id));
      await tx
        .update(refunds)
        .set({ createdAt: ist(today, "11:00") })
        .where(eq(refunds.paymentId, cash.id));
    });

    expect(await report(g, "revenue")).toEqual({
      from: addDays(today, -29),
      to: today,
      collectedPaise: 180_000,
      refundedPaise: 30_000,
      netPaise: 150_000,
      byDay: [
        { date: threeDaysAgo, collectedPaise: 80_000, refundedPaise: 0 },
        { date: today, collectedPaise: 100_000, refundedPaise: 30_000 },
      ],
      byMethod: [
        { method: "cash", collectedPaise: 100_000 },
        { method: "upi_qr", collectedPaise: 80_000 },
      ],
    });
    const quarter = await report(g, `revenue?from=${addDays(today, -89)}&to=${today}`);
    expect(quarter.collectedPaise).toBe(230_000);
    expect(
      (await g.call("GET", `${g.base}/reports/revenue?from=${today}&to=${addDays(today, -1)}`))
        .statusCode,
    ).toBe(400);
    expect(
      (await g.call("GET", `${g.base}/reports/revenue?from=2020-01-01&to=${today}`)).statusCode,
    ).toBe(400);
  });
});

describe("dues", () => {
  it("groups unpaid invoices by how late they are", async () => {
    const g = await gymWithMember(api, dbh.db);
    const today = todayIn(IST);
    const fresh = await invoiceFor(g, 100_000);
    const late = await invoiceFor(g, 200_000);
    const veryLate = await invoiceFor(g, 150_000);
    const paid = await invoiceFor(g, 90_000);
    await pay(g, late.id, "cash", 50_000);
    await pay(g, paid.id, "cash", 90_000);
    await withTenant(dbh.db, orgOf(g), async (tx) => {
      await tx
        .update(invoices)
        .set({ dueDate: addDays(today, 5) })
        .where(eq(invoices.id, fresh.id));
      await tx
        .update(invoices)
        .set({ dueDate: addDays(today, -10) })
        .where(eq(invoices.id, late.id));
      await tx
        .update(invoices)
        .set({ dueDate: addDays(today, -95) })
        .where(eq(invoices.id, veryLate.id));
    });

    expect(await report(g, "dues")).toEqual({
      asOf: today,
      duePaise: 400_000,
      invoices: 3,
      buckets: [
        { bucket: "not_due", invoices: 1, duePaise: 100_000 },
        { bucket: "1_30", invoices: 1, duePaise: 150_000 },
        { bucket: "31_60", invoices: 0, duePaise: 0 },
        { bucket: "61_90", invoices: 0, duePaise: 0 },
        { bucket: "90_plus", invoices: 1, duePaise: 150_000 },
      ],
    });
  });
});

describe("attendance", () => {
  it("counts visits by weekday and hour in the gym's time zone", async () => {
    const g = await gymWithMember(api, dbh.db);
    const today = todayIn(IST);
    const ids = await g.membersWithMembership(2);
    const day = addDays(today, -7);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const visit = (memberId: string, at: Date) => ({
      tenantId: orgOf(g),
      branchId: g.branch.id,
      memberId,
      method: "desk" as const,
      checkedInAt: at,
      checkedOutAt: new Date(at.getTime() + 3_600_000),
    });
    await withTenant(dbh.db, orgOf(g), (tx) =>
      tx.insert(checkIns).values([
        visit(ids[0] ?? "", ist(day, "06:10")),
        visit(ids[1] ?? "", ist(day, "06:45")),
        visit(ids[0] ?? "", ist(addDays(day, 1), "18:30")),
        visit(ids[1] ?? "", ist(addDays(today, -60), "07:00")), // outside the default range
      ]),
    );

    expect(await report(g, "attendance")).toEqual({
      from: addDays(today, -29),
      to: today,
      visits: 3,
      members: 2,
      heatmap: [
        { weekday, hour: 6, visits: 2 },
        { weekday: (weekday + 1) % 7, hour: 18, visits: 1 },
      ].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
    });
  });
});

describe("retention", () => {
  it("follows each month's new members and how many still have a membership later", async () => {
    const g = await gymWithMember(api, dbh.db);
    const today = todayIn(IST);
    const monthStart = (back: number) => {
      const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - back);
      return d.toISOString().slice(0, 10);
    };
    const ids = await g.membersWithMembership(4);
    const [stayed, left, renewed, recent] = ids as [string, string, string, string];
    const set = (memberId: string, startDate: string, endDate: string) =>
      withTenant(dbh.db, orgOf(g), (tx) =>
        tx
          .update(memberships)
          .set({ startDate, endDate, status: "expired" })
          .where(eq(memberships.memberId, memberId)),
      );
    // Two months ago: one stays for three months, one leaves within the month, one comes back later.
    await set(stayed, addDays(monthStart(2), 4), addDays(monthStart(2), 95));
    await set(left, addDays(monthStart(2), 9), addDays(monthStart(2), 20));
    await set(renewed, addDays(monthStart(2), 1), addDays(monthStart(2), 25));
    const [first] = await withTenant(dbh.db, orgOf(g), (tx) =>
      tx.select().from(memberships).where(eq(memberships.memberId, renewed)),
    );
    if (!first) throw new Error("no membership");
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = first;
    await withTenant(dbh.db, orgOf(g), (tx) =>
      tx
        .insert(memberships)
        .values({ ...copy, startDate: monthStart(0), endDate: addDays(monthStart(0), 29) }),
    );
    // This month: a new member.
    await set(recent, monthStart(0), addDays(monthStart(0), 29));

    const { cohorts } = await report(g, "retention?months=3");
    expect(cohorts).toEqual([
      { month: monthStart(2).slice(0, 7), members: 3, retained: [3, 1, 2] },
      { month: monthStart(0).slice(0, 7), members: 1, retained: [1] },
    ]);
  });
});

describe("summary", () => {
  it("gives today's key numbers for the owner dashboard", async () => {
    const g = await gymWithMember(api, dbh.db);
    const orgId = orgOf(g);
    const today = todayIn(IST);
    const ids = await g.membersWithMembership(5);
    const [ending, frozen, old, renewed, plain] = ids as [string, string, string, string, string];
    await withTenant(dbh.db, orgId, async (tx) => {
      const update = (memberId: string, set: Partial<typeof memberships.$inferInsert>) =>
        tx.update(memberships).set(set).where(eq(memberships.memberId, memberId));
      // All started this month except `old`, which started three months ago and has expired.
      await tx
        .update(memberships)
        .set({ startDate: today.slice(0, 8) + "01" })
        .where(eq(memberships.tenantId, orgId));
      await update(ending, { endDate: addDays(today, 3) });
      await update(renewed, { endDate: addDays(today, 5) });
      await update(frozen, { status: "frozen" });
      await update(old, {
        status: "expired",
        startDate: addDays(today, -95),
        endDate: addDays(today, -5),
      });
      const [current] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.memberId, renewed));
      if (!current) throw new Error("no membership");
      const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = current;
      await tx.insert(memberships).values({
        ...copy,
        status: "pending",
        startDate: addDays(today, 6),
        endDate: addDays(today, 35),
      });
      await tx.insert(checkIns).values(
        [plain, ending].map((memberId) => ({
          tenantId: orgId,
          branchId: g.branch.id,
          memberId,
          method: "desk" as const,
          checkedInAt: new Date(),
          checkedOutAt: new Date(),
        })),
      );
      await tx.insert(leads).values([
        {
          tenantId: orgId,
          branchId: g.branch.id,
          name: "A",
          phone: "+919811111111",
          source: "walk_in",
        },
        {
          tenantId: orgId,
          branchId: g.branch.id,
          name: "B",
          phone: "+919822222222",
          source: "walk_in",
          stage: "lost",
          lostReason: "x",
        },
      ]);
    });
    const invoice = await invoiceFor(g, 120_000);
    await pay(g, invoice.id, "cash", 20_000);

    expect(await report(g, "summary")).toEqual({
      asOf: today,
      activeMembers: 4, // ending, renewed, plain and the payer (frozen and expired do not count)
      frozenMembers: 1,
      renewalsDue7Days: 1, // ending; renewed already has its next membership booked
      newMembersThisMonth: 5, // everyone but `old`
      openLeads: 1,
      visitsToday: 2,
      duePaise: 100_000,
    });
  });
});

describe("access to reports", () => {
  it("is for owners and gym-wide managers only", async () => {
    const g = await gymWithMember(api, dbh.db);
    const desk = await g.staff("front_desk");
    const branchManager = await g.staff("manager", [g.branch.id]);
    const get = (headers: Record<string, string>) =>
      api.inject({ method: "GET", url: `${g.base}/reports/dues`, headers });
    expect((await get(desk.headers)).statusCode).toBe(403);
    expect((await get(branchManager.headers)).statusCode).toBe(403);
    expect((await get((await g.staff("manager")).headers)).statusCode).toBe(200);
  });
});
