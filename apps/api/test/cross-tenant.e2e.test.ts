import { routes, type Route } from "@gym/contracts";
import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import {
  bookings,
  branches,
  checkIns,
  classes,
  classSessions,
  kiosks,
  members,
  memberships,
  organisations,
  plans,
  staffInvites,
  staffMembers,
} from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { issueMembershipInvoice } from "../src/billing/invoicing";
import type { ConsoleSmsSender } from "../src/auth/senders";
import { SMS_SENDER } from "../src/tokens";
import { signedInStaff, testEnv } from "./helpers";

/**
 * The isolation guarantee, checked for EVERY gym-scoped endpoint in the API contract: someone who works at
 * gym A can never read or change gym B's data, whether they put gym B's id in the URL or smuggle gym B's
 * branch / staff / invite ids into gym A's URLs. New endpoints are picked up automatically; one with a request
 * body fails this test until a valid sample body is added below.
 */
const SAMPLE_BODIES: Record<string, object> = {
  updateOrganisation: { name: "Taken over" },
  createBranch: { name: "Intruder branch", city: "Pune" },
  createKiosk: { name: "Intruder kiosk" },
  deskCheckIn: { memberId: "00000000-0000-7000-8000-000000000000" },
  createClass: {
    name: "Intruder class",
    capacity: 5,
    durationMinutes: 60,
    weekdays: [1],
    startTime: "07:00",
  },
  updateClass: { name: "Renamed by intruder" },
  cancelClassSession: { reason: "Intruder" },
  bookSession: { memberId: "00000000-0000-7000-8000-000000000000" },
  markAttendance: { attended: true },
  updateBranch: { name: "Renamed by intruder" },
  inviteStaff: { channel: "sms", phone: "+919000000001", role: "trainer" },
  updateStaff: { role: "trainer" },
  createPlan: { name: "Intruder plan", durationUnit: "month", durationCount: 1, pricePaise: 100 },
  updatePlan: { pricePaise: 1 },
  createMember: { name: "Intruder member", homeBranchId: "01930000-0000-7000-8000-0000000000ff" },
  updateMember: { name: "Renamed by intruder" },
  enrolMember: { planId: "01930000-0000-7000-8000-0000000000ee" },
  freezeMembership: { days: 3 },
  changeMembershipPlan: { planId: "01930000-0000-7000-8000-0000000000ee" },
  cancelMembership: { reason: "Cancelled by intruder" },
  recordPayment: { method: "cash", amountPaise: 100 },
  refundPayment: { amountPaise: 1, reason: "Refunded by intruder" },
  createMemberImport: {
    fileName: "x.csv",
    csv: "Name\nIntruder",
    defaultBranchId: "01930000-0000-7000-8000-0000000000ff",
  },
};

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
const victim: Record<string, string> = {};
let attackerOrgId = "";
let attackerHeaders: Record<string, string> = {};

const tenantRoutes = Object.entries(routes as Record<string, Route>).filter(([, r]) =>
  r.path.includes("{orgId}"),
);
const fill = (path: string, ids: Record<string, string>) =>
  path.replace(/\{(\w+)\}/g, (_, name: string) => ids[name] ?? "");

async function snapshot() {
  return withTenant(dbh.db, victim.orgId ?? "", async (tx) => ({
    org: await tx.select().from(organisations),
    branches: await tx.select().from(branches),
    staff: await tx.select().from(staffMembers),
    invites: await tx.select().from(staffInvites),
    plans: await tx.select().from(plans),
    members: await tx.select().from(members),
    memberships: await tx.select().from(memberships),
    kiosks: await tx.select().from(kiosks),
    checkIns: await tx.select().from(checkIns),
    classes: await tx.select().from(classes),
    sessions: await tx.select().from(classSessions),
    bookings: await tx.select().from(bookings),
  }));
}

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  const sms = api.get<ConsoleSmsSender>(SMS_SENDER);

  const victimOwner = await signedInStaff(api, dbh.db, { name: "Victim owner" });
  const created = (
    await api.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: victimOwner.headers,
      payload: { name: "Victim Gym", branch: { name: "Main", city: "Pune" } },
    })
  ).json();
  victim.orgId = created.organisation.id;
  victim.branchId = created.branch.id;
  const base = `/v1/orgs/${victim.orgId}`;
  const phone = `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  await api.inject({
    method: "POST",
    url: `${base}/invites`,
    headers: victimOwner.headers,
    payload: { channel: "sms", phone, role: "trainer" },
  });
  const token = /\/invite\/([\w.-]+)/.exec(sms.sent.at(-1)?.text ?? "")?.[1];
  const trainer = await signedInStaff(api, dbh.db, { phone });
  await api.inject({
    method: "POST",
    url: "/v1/invites/accept",
    headers: trainer.headers,
    payload: { token },
  });
  const pending = await api.inject({
    method: "POST",
    url: `${base}/invites`,
    headers: victimOwner.headers,
    payload: { channel: "sms", phone: "+919000000002", role: "front_desk" },
  });
  victim.inviteId = pending.json().id;
  const staff = (
    await api.inject({ method: "GET", url: `${base}/staff`, headers: victimOwner.headers })
  ).json() as { id: string; role: string }[];
  victim.staffId = staff.find((s) => s.role === "trainer")?.id ?? "";
  victim.planId = (
    await api.inject({
      method: "POST",
      url: `${base}/plans`,
      headers: victimOwner.headers,
      payload: {
        name: "Victim plan",
        durationUnit: "month",
        durationCount: 1,
        pricePaise: 150_000,
      },
    })
  ).json().id;
  victim.memberId = (
    await api.inject({
      method: "POST",
      url: `${base}/members`,
      headers: victimOwner.headers,
      payload: { name: "Victim member", homeBranchId: victim.branchId },
    })
  ).json().id;

  await api.inject({
    method: "PATCH",
    url: `${base}/plans/${victim.planId}`,
    headers: victimOwner.headers,
    payload: { maxFreezes: 2, maxFreezeDays: 30 },
  });
  victim.membershipId = (
    await api.inject({
      method: "POST",
      url: `${base}/members/${victim.memberId}/memberships`,
      headers: victimOwner.headers,
      payload: { planId: victim.planId },
    })
  ).json().id;

  const sale = await withTenant(dbh.db, victim.orgId ?? "", async (tx) => {
    const [m] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, victim.membershipId ?? ""));
    if (!m) throw new Error("victim membership missing");
    return issueMembershipInvoice(tx, victim.orgId ?? "", {
      membershipId: m.id,
      memberId: m.memberId,
      planId: m.planId,
      startDate: m.startDate,
      endDate: m.endDate,
      pricePaise: m.pricePaise,
      joiningFeePaise: m.joiningFeePaise,
      gstRateBps: m.gstRateBps,
      gstPaise: m.gstPaise,
      totalPaise: m.totalPaise,
    });
  });
  victim.invoiceId = sale?.id ?? "";
  victim.paymentId = (
    await api.inject({
      method: "POST",
      url: `${base}/invoices/${victim.invoiceId}/payments`,
      headers: { ...victimOwner.headers, "idempotency-key": "victim-pay" },
      payload: { method: "cash", amountPaise: 1000 },
    })
  ).json().id;
  victim.kioskId = (
    await api.inject({
      method: "POST",
      url: `${base}/branches/${victim.branchId}/kiosks`,
      headers: victimOwner.headers,
      payload: { name: "Victim door" },
    })
  ).json().id;
  const visit = (
    await api.inject({
      method: "POST",
      url: `${base}/branches/${victim.branchId}/check-ins`,
      headers: victimOwner.headers,
      payload: { memberId: victim.memberId },
    })
  ).json();
  victim.checkInId = visit.visit?.id ?? "";
  victim.classId = (
    await api.inject({
      method: "POST",
      url: `${base}/branches/${victim.branchId}/classes`,
      headers: victimOwner.headers,
      payload: {
        name: "Victim yoga",
        capacity: 10,
        durationMinutes: 60,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startTime: "23:30",
      },
    })
  ).json().id;
  const [victimSession] = await withTenant(dbh.db, victim.orgId ?? "", (tx) =>
    tx
      .select()
      .from(classSessions)
      .where(eq(classSessions.classId, victim.classId ?? "")),
  );
  victim.sessionId = victimSession?.id ?? "";
  expect(victim.sessionId).not.toBe("");
  victim.bookingId = (
    await api.inject({
      method: "POST",
      url: `${base}/sessions/${victim.sessionId}/bookings`,
      headers: victimOwner.headers,
      payload: { memberId: victim.memberId },
    })
  ).json().id;
  expect(victim.bookingId).toBeTruthy();
  expect(victim.checkInId).not.toBe("");

  const attacker = await signedInStaff(api, dbh.db, { name: "Attacker owner" });
  attackerHeaders = attacker.headers;
  attackerOrgId = (
    await api.inject({
      method: "POST",
      url: "/v1/orgs",
      headers: attacker.headers,
      payload: { name: "Attacker Gym", branch: { name: "Main", city: "Pune" } },
    })
  ).json().organisation.id;
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

describe("cross-tenant isolation matrix", () => {
  it("covers every gym-scoped endpoint", () => {
    expect(tenantRoutes.length).toBeGreaterThanOrEqual(11);
    for (const [name, route] of tenantRoutes) {
      if (route.body && !SAMPLE_BODIES[name])
        throw new Error(`Add a valid sample body for "${name}" to SAMPLE_BODIES`);
    }
  });

  it.each(tenantRoutes)("%s: another gym's id in the URL is not found", async (name, route) => {
    const res = await api.inject({
      method: route.method,
      url: fill(route.path, victim),
      headers: { ...attackerHeaders, "idempotency-key": `attack-${Math.random()}` },
      ...(route.body && { payload: SAMPLE_BODIES[name] }),
    });
    expect(res.statusCode, `${route.method} ${route.path}`).toBe(404);
  });

  it.each(tenantRoutes.filter(([, r]) => (r.path.match(/\{/g) ?? []).length > 1))(
    "%s: another gym's record inside my own gym's URL is not found",
    async (name, route) => {
      const res = await api.inject({
        method: route.method,
        url: fill(route.path, { ...victim, orgId: attackerOrgId }),
        headers: { ...attackerHeaders, "idempotency-key": `attack-${Math.random()}` },
        ...(route.body && { payload: SAMPLE_BODIES[name] }),
      });
      expect(res.statusCode, `${route.method} ${route.path}`).toBe(404);
    },
  );

  it("the other gym's data is untouched after all of the above", async () => {
    const after = await snapshot();
    expect(after.org.map((o) => o.name)).toEqual(["Victim Gym"]);
    expect(after.branches.map((b) => b.name)).toEqual(["Main"]);
    expect(after.staff.map((s) => s.role).sort()).toEqual(["owner", "trainer"]);
    expect(after.invites.find((i) => i.id === victim.inviteId)?.revokedAt).toBeNull();
    expect(after.plans.map((p) => [p.name, p.pricePaise])).toEqual([["Victim plan", 150_000]]);
    expect(after.members.map((m) => m.name)).toEqual(["Victim member"]);
    expect(after.memberships.map((m) => m.status)).toEqual(["active"]);
  });
});
