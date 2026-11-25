import { createDb, PERSONAL_DATA, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import {
  authIdentities,
  autopayMandates,
  bookings,
  checkIns,
  classSessions,
  memberships,
  otpChallenges,
  recoveryCodes,
  staffMembers,
  userMfa,
} from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 } from "uuid";
import { createApp } from "../src/app";
import { issueMembershipInvoice } from "../src/billing/invoicing";
import { notify } from "../src/notifications/delivery";
import { NOT_EXPORTED } from "../src/privacy/export";
import { runPrivacyRequests } from "../src/privacy/requests";
import { gymWithMember, signedInUser, testEnv } from "./helpers";

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

type Gym = Awaited<ReturnType<typeof gymWithMember>>;
const orgOf = (g: Gym) => g.base.split("/").pop() ?? "";
const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, "0");

/**
 * A person with data in every personal-data table: an app account, a member record at `gym` (with a membership,
 * invoice, payment, refund, freeze, visit, booking, messages, lead and AutoPay), training data, and a job at
 * `workplace`.
 */
async function personWithEverything(gym: Gym, workplace: Gym, name: string) {
  const phone = `+9195${digits()}`;
  const email = `${name.toLowerCase()}-${digits()}@example.com`;
  const person = await signedInUser(api, dbh.db, { name, phone, email });
  const userId = person.user.id;
  const as = (method: string, url: string, payload?: object) =>
    api.inject({ method, url, headers: person.headers, ...(payload && { payload }) });
  const orgId = orgOf(gym);

  // Account.
  await dbh.db.insert(otpChallenges).values({
    channel: "sms",
    destination: phone,
    codeHash: "x",
    expiresAt: new Date(Date.now() + 60_000),
    ip: "10.0.0.1",
  });
  await dbh.db
    .insert(authIdentities)
    .values({ userId, provider: "google", subject: `g-${digits()}`, email });
  await dbh.db.insert(userMfa).values({ userId, totpSecretEnc: "encrypted" });
  await dbh.db.insert(recoveryCodes).values({ userId, codeHash: "hashed" });
  await as("POST", "/v1/me/consents", {
    purpose: "health_data",
    granted: true,
    policyVersion: "2026-11",
  });
  await as("POST", "/v1/me/devices", { token: `ExponentPushToken[${v7()}]`, platform: "android" });
  await withTenant(dbh.db, orgOf(workplace), (tx) =>
    tx.insert(staffMembers).values({ tenantId: orgOf(workplace), userId, role: "trainer" }),
  );
  const invite = await gym.call("POST", `${gym.base}/invites`, {
    channel: "sms",
    phone,
    role: "front_desk",
  });
  expect(invite.statusCode).toBe(201);

  // Training.
  const exerciseId = v7();
  const workoutId = v7();
  const now = new Date().toISOString();
  const sync = await as("POST", "/v1/me/sync", {
    batch: [
      {
        op: "PUT",
        type: "exercises",
        id: exerciseId,
        data: {
          name: `${name}'s press`,
          primary_muscle: "chest",
          equipment: "other",
          tracking: "weight_reps",
        },
      },
      { op: "PUT", type: "workouts", id: workoutId, data: { name: "Push", started_at: now } },
      {
        op: "PUT",
        type: "workout_sets",
        id: v7(),
        data: {
          workout_id: workoutId,
          exercise_id: exerciseId,
          position: 1,
          reps: 5,
          weight_kg: 50,
          completed_at: now,
        },
      },
      {
        op: "PUT",
        type: "workout_templates",
        id: v7(),
        data: { name: "Push plan", exercises: [] },
      },
      {
        op: "PUT",
        type: "body_metrics",
        id: v7(),
        data: { kind: "weight_kg", value: 70, measured_at: now },
      },
    ],
  });
  expect(sync.statusCode).toBe(200);

  // Member at the gym, linked to the account by phone.
  const memberId = (
    await gym.call("POST", `${gym.base}/members`, {
      name,
      phone,
      email,
      homeBranchId: gym.branch.id,
    })
  ).json().id as string;
  await as("GET", "/v1/me/gyms");
  await as("GET", `/v1/me/gyms/${orgId}/pass`);
  await as("PATCH", `/v1/me/gyms/${orgId}/notification-preferences`, { locale: "hi" });
  const plan = await gym.plan({
    pricePaise: 100_000,
    joiningFeePaise: 0,
    gstRateBps: 0,
    maxFreezes: 1,
    maxFreezeDays: 10,
  });
  const membershipId = (
    await gym.call("POST", `${gym.base}/members/${memberId}/memberships`, { planId: plan.id })
  ).json().id as string;
  const invoice = await withTenant(dbh.db, orgId, async (tx) => {
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId));
    if (!m) throw new Error("no membership");
    return issueMembershipInvoice(tx, orgId, { ...m, membershipId: m.id });
  });
  const money = { ...gym.owner.headers };
  const payment = (
    await api.inject({
      method: "POST",
      url: `${gym.base}/invoices/${invoice?.id}/payments`,
      headers: { ...money, "idempotency-key": v7() },
      payload: { method: "cash", amountPaise: 60_000 },
    })
  ).json().id as string;
  await api.inject({
    method: "POST",
    url: `${gym.base}/payments/${payment}/refunds`,
    headers: { ...money, "idempotency-key": v7() },
    payload: { amountPaise: 1_000, reason: "Overcharged" },
  });
  const freeze = await gym.call("POST", `${gym.base}/memberships/${membershipId}/freeze`, {
    days: 3,
    reason: "Travel",
  });
  expect(freeze.statusCode).toBeLessThan(300);
  const [session] = await withTenant(dbh.db, orgId, (tx) =>
    tx
      .insert(classSessions)
      .values({
        tenantId: orgId,
        branchId: gym.branch.id,
        kind: "class",
        name: "Yoga",
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 90_000_000),
        capacity: 5,
        cancelWindowMinutes: 60,
      })
      .returning(),
  );
  await withTenant(dbh.db, orgId, async (tx) => {
    await tx
      .insert(bookings)
      .values({ tenantId: orgId, sessionId: session?.id ?? "", memberId, status: "confirmed" });
    await tx.insert(checkIns).values({
      tenantId: orgId,
      branchId: gym.branch.id,
      memberId,
      method: "desk",
      checkedOutAt: new Date(),
    });
    await tx.insert(autopayMandates).values({
      tenantId: orgId,
      memberId,
      status: "active",
      maxAmountPaise: 500_000,
      gateway: "fake",
      gatewayCustomerId: `cust_${digits()}`,
      gatewayOrderId: `order_${digits()}`,
    });
    await notify(tx, {
      tenantId: orgId,
      memberId,
      key: "inactive",
      vars: { name, gym: "Test Gym" },
      dedupeKey: `t:${v7()}`,
    });
  });
  const lead = (
    await gym.call("POST", `${gym.base}/leads`, {
      name,
      phone,
      branchId: gym.branch.id,
      source: "walk_in",
    })
  ).json().id as string;
  await gym.call("POST", `${gym.base}/leads/${lead}/tasks`, { title: `Call ${name}`, dueAt: now });

  return { person, userId, memberId, phone, email, name };
}

describe("data export (right to access)", () => {
  it("contains every kind of personal data held about me, and nothing about anyone else", async () => {
    const gym = await gymWithMember(api, dbh.db);
    const workplace = await gymWithMember(api, dbh.db);
    const me = await personWithEverything(gym, workplace, "Asha");
    const other = await personWithEverything(gym, workplace, "Bhavna");

    const asked = await api.inject({
      method: "POST",
      url: "/v1/me/privacy/exports",
      headers: me.person.headers,
    });
    expect(asked.statusCode).toBe(202);
    const request = asked.json() as { id: string; status: string };
    expect(request.status).toBe("pending");
    const url = `/v1/me/privacy/exports/${request.id}`;
    expect((await api.inject({ method: "GET", url, headers: me.person.headers })).statusCode).toBe(
      409,
    );

    await runPrivacyRequests(dbh.db);
    const res = await api.inject({ method: "GET", url, headers: me.person.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const exported = res.json() as { data: Record<string, unknown[]>; gyms: { name: string }[] };

    // Every personal-data table is either in the export with my rows, or listed as not included (with why).
    const expected = Object.keys(PERSONAL_DATA)
      .filter((t) => !(t in NOT_EXPORTED))
      .sort();
    expect(Object.keys(exported.data).sort()).toEqual(expected);
    for (const table of expected) expect(exported.data[table]?.length, table).toBeGreaterThan(0);

    const text = res.body;
    for (const value of [me.userId, me.memberId, me.phone, me.email]) expect(text).toContain(value);
    for (const value of [other.userId, other.memberId, other.phone, other.email, other.name])
      expect(text).not.toContain(value);
    // Credentials are never part of an export.
    expect(text).not.toMatch(/"\w*(Hash|Secret|Enc)"\s*:/);
  });

  it("is mine alone, is not repeated within a day, and expires after 7 days", async () => {
    const someone = await signedInUser(api, dbh.db);
    const stranger = await signedInUser(api, dbh.db);
    const ask = () =>
      api.inject({ method: "POST", url: "/v1/me/privacy/exports", headers: someone.headers });
    const first = (await ask()).json() as { id: string };
    expect((await ask()).json().id).toBe(first.id);
    await runPrivacyRequests(dbh.db);
    const url = `/v1/me/privacy/exports/${first.id}`;
    expect((await api.inject({ method: "GET", url, headers: stranger.headers })).statusCode).toBe(
      404,
    );
    const list = await api.inject({
      method: "GET",
      url: "/v1/me/privacy/requests",
      headers: someone.headers,
    });
    expect(list.json()).toEqual([
      expect.objectContaining({ id: first.id, kind: "export", status: "done" }),
    ]);

    await runPrivacyRequests(dbh.db, new Date(Date.now() + 8 * 86_400_000));
    expect((await api.inject({ method: "GET", url, headers: someone.headers })).statusCode).toBe(
      410,
    );
  });
});
