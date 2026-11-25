import { createDb, withTenant, type DbHandle } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { checkIns, invoices, members, memberships, outboxEvents } from "@gym/db/schema";
import { addDays } from "@gym/domain";
import { Secret, TOTP } from "otpauth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAutoCheckOut } from "../src/access/occupancy";
import { checkPassCode } from "../src/access/passes";
import { createApp } from "../src/app";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, signedInUser, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let worker: WorkerHandle;

beforeAll(async () => {
  // The parallel check-in test sends 1,000 requests as one owner.
  ({ app: api } = await createApp(testEnv({ RATE_LIMIT_MAX: "5000" })));
  dbh = createDb(testEnv().DATABASE_URL);
  worker = await createWorker(testEnv({ OUTBOX_POLL_MS: "50" }));
});
afterAll(async () => {
  await worker.close();
  await api.close();
  await dbh.pool.end();
});

type Gym = Awaited<ReturnType<typeof gymWithMember>>;

const randomPhone = () => `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

/** A member at gym `g` with this phone number. */
async function memberWithPhone(g: Gym, phone: string, name = "Asha") {
  const res = await g.call("POST", `${g.base}/members`, {
    name,
    phone,
    homeBranchId: g.branch.id,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

const get = (url: string, headers: Record<string, string>) =>
  api.inject({ method: "GET", url, headers });

describe("members' app accounts", () => {
  it("links every gym's member record with my verified phone number to my account", async () => {
    const phone = randomPhone();
    const a = await gymWithMember(api, dbh.db);
    const b = await gymWithMember(api, dbh.db);
    const other = await gymWithMember(api, dbh.db);
    const atA = await memberWithPhone(a, phone);
    const atB = await memberWithPhone(b, phone, "Asha K");
    await memberWithPhone(other, randomPhone());

    const me = await signedInUser(api, dbh.db, { phone });
    const res = await get("/v1/me/gyms", me.headers);
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .map((g: { memberId: string }) => g.memberId)
        .sort(),
    ).toEqual([atA.id, atB.id].sort());
    expect(res.json()[0]).toMatchObject({ orgName: "Test Gym" });
    const [linked] = await dbh.db.select().from(members).where(eq(members.id, atA.id));
    expect(linked?.userId).toBe(me.user.id);
  });

  it("shows nothing to someone without a verified phone, or without sign-in", async () => {
    const g = await gymWithMember(api, dbh.db);
    await memberWithPhone(g, randomPhone());
    const emailOnly = await signedInUser(api, dbh.db, {
      email: `x${Math.random()}@example.com`,
    });
    expect((await get("/v1/me/gyms", emailOnly.headers)).json()).toEqual([]);
    expect((await get("/v1/me/gyms", {})).statusCode).toBe(401);
  });
});

/** A gym, a member there signed in to the app, and their pass. */
async function memberWithPass() {
  const g = await gymWithMember(api, dbh.db);
  const phone = randomPhone();
  const member = await memberWithPhone(g, phone);
  const me = await signedInUser(api, dbh.db, { phone });
  const orgId = g.base.split("/").at(-1) ?? "";
  const res = await get(`/v1/me/gyms/${orgId}/pass`, me.headers);
  const pass = res.json();
  const totp = new TOTP({
    secret: Secret.fromBase32(pass.secret),
    algorithm: pass.algorithm,
    digits: pass.digits,
    period: pass.period,
  });
  /** The QR text the app shows at this moment. */
  const qr = (at: Date) => `${pass.qrPrefix}${totp.generate({ timestamp: at.getTime() })}`;
  return { g, me, member, orgId, res, pass, qr };
}

const key = () => testEnv().AUTH_ENCRYPTION_KEY;
const check = (orgId: string, qr: string, at: Date) =>
  withTenant(dbh.db, orgId, (tx) => checkPassCode(tx, qr, key(), at));

describe("gym pass", () => {
  it("gives a member a pass that stays the same, and nobody else one", async () => {
    const t = await memberWithPass();
    expect(t.res.statusCode).toBe(200);
    expect(t.pass).toMatchObject({
      memberId: t.member.id,
      digits: 8,
      period: 30,
      qrPrefix: `gp1.${t.member.id}.`,
    });
    expect((await get(`/v1/me/gyms/${t.orgId}/pass`, t.me.headers)).json().secret).toBe(
      t.pass.secret,
    );
    const stranger = await signedInUser(api, dbh.db, { phone: randomPhone() });
    expect((await get(`/v1/me/gyms/${t.orgId}/pass`, stranger.headers)).statusCode).toBe(404);
  });

  it("accepts each code once, and never an older one after a newer one", async () => {
    const t = await memberWithPass();
    const now = new Date();
    expect(await check(t.orgId, t.qr(now), now)).toEqual({ ok: true, memberId: t.member.id });
    expect(await check(t.orgId, t.qr(now), now)).toEqual({
      ok: false,
      reason: "code_already_used",
    });
    const earlier = new Date(now.getTime() - 30_000);
    expect(await check(t.orgId, t.qr(earlier), now)).toMatchObject({ reason: "code_already_used" });
  });

  it("allows 30 seconds of clock difference either way, but not more", async () => {
    const t = await memberWithPass();
    const now = new Date();
    expect(await check(t.orgId, t.qr(new Date(now.getTime() - 61_000)), now)).toMatchObject({
      reason: "invalid_code",
    });
    expect(await check(t.orgId, t.qr(new Date(now.getTime() + 61_000)), now)).toMatchObject({
      reason: "invalid_code",
    });
    expect(await check(t.orgId, t.qr(new Date(now.getTime() - 30_000)), now)).toMatchObject({
      ok: true,
    });
    expect(await check(t.orgId, t.qr(new Date(now.getTime() + 30_000)), now)).toMatchObject({
      ok: true,
    });
  });

  it("rejects garbage, and a real code at another gym", async () => {
    const t = await memberWithPass();
    const elsewhere = await gymWithMember(api, dbh.db);
    const now = new Date();
    for (const qr of ["", "hello", `gp1.${t.member.id}.12`, `gp1.${t.member.id}.abcdefgh`]) {
      expect(await check(t.orgId, qr, now)).toMatchObject({ reason: "invalid_code" });
    }
    expect(await check(elsewhere.base.split("/").at(-1) ?? "", t.qr(now), now)).toMatchObject({
      reason: "invalid_code",
    });
  });

  it("lets exactly one of many simultaneous scans of the same code through", async () => {
    const t = await memberWithPass();
    const now = new Date();
    const qr = t.qr(now);
    const results = await Promise.all(Array.from({ length: 20 }, () => check(t.orgId, qr, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

const kioskCall = (token: string | undefined) =>
  api.inject({
    method: "GET",
    url: "/v1/kiosk",
    headers: token === undefined ? {} : { "x-kiosk-token": token },
  });

/** A gym with a registered check-in device at its main branch. */
async function gymWithKiosk() {
  const g = await gymWithMember(api, dbh.db);
  const orgId = g.base.split("/").at(-1) ?? "";
  const res = await g.call("POST", `${g.base}/branches/${g.branch.id}/kiosks`, { name: "Door" });
  return { g, orgId, res, kiosk: res.json() as { id: string; token: string } };
}

describe("check-in devices", () => {
  it("are registered per branch with a token shown once, and can be revoked", async () => {
    const t = await gymWithKiosk();
    expect(t.res.statusCode).toBe(201);
    expect(t.kiosk.token.startsWith(`kio.${t.orgId}.`)).toBe(true);
    expect((await kioskCall(t.kiosk.token)).json()).toEqual({
      id: t.kiosk.id,
      orgId: t.orgId,
      branchId: t.g.branch.id,
      name: "Door",
    });
    const [listed] = (await t.g.call("GET", `${t.g.base}/kiosks`)).json();
    expect(listed).toMatchObject({ id: t.kiosk.id, name: "Door" });
    expect(listed.lastSeenAt).not.toBeNull();
    expect(listed).not.toHaveProperty("token");

    expect((await t.g.call("DELETE", `${t.g.base}/kiosks/${t.kiosk.id}`)).statusCode).toBe(204);
    expect((await kioskCall(t.kiosk.token)).statusCode).toBe(401);
    expect((await t.g.call("GET", `${t.g.base}/kiosks`)).json()).toEqual([]);
    expect((await t.g.call("DELETE", `${t.g.base}/kiosks/${t.kiosk.id}`)).statusCode).toBe(404);
  });

  it("refuse missing, malformed and forged tokens", async () => {
    const t = await gymWithKiosk();
    const forged = `${t.kiosk.token.slice(0, -4)}AAAA`;
    for (const token of [undefined, "", "Bearer x", "kio.not-a-uuid.x", forged]) {
      expect((await kioskCall(token)).statusCode).toBe(401);
    }
  });

  it("are managed by owners and managers only, within their branches", async () => {
    const t = await gymWithKiosk();
    const desk = await t.g.staff("front_desk");
    const url = `${t.g.base}/branches/${t.g.branch.id}/kiosks`;
    expect(
      (await api.inject({ method: "POST", url, headers: desk.headers, payload: { name: "x" } }))
        .statusCode,
    ).toBe(403);
    const other = (
      await t.g.call("POST", `${t.g.base}/branches`, { name: "Second", city: "Pune" })
    ).json();
    const manager = await t.g.staff("manager", [other.id]);
    const asManager = (method: string, path: string, payload?: object) =>
      api.inject({
        method,
        url: `${t.g.base}${path}`,
        headers: manager.headers,
        ...(payload && { payload }),
      });
    expect(
      (await asManager("POST", `/branches/${t.g.branch.id}/kiosks`, { name: "x" })).statusCode,
    ).toBe(404);
    expect((await asManager("GET", "/kiosks")).json()).toEqual([]);
    expect((await asManager("DELETE", `/kiosks/${t.kiosk.id}`)).statusCode).toBe(404);
    expect(
      (await asManager("POST", `/branches/${other.id}/kiosks`, { name: "Side door" })).statusCode,
    ).toBe(201);
  });
});

/** A member with a running membership, their pass, and a check-in device at their branch. */
async function readyToEnter(plan: object = {}) {
  const t = await memberWithPass();
  const planId = (await t.g.plan(plan)).id;
  const enrolled = await t.g.call("POST", `${t.g.base}/members/${t.member.id}/memberships`, {
    planId,
  });
  expect(enrolled.statusCode).toBe(201);
  const kiosk = (
    await t.g.call("POST", `${t.g.base}/branches/${t.g.branch.id}/kiosks`, { name: "Door" })
  ).json();
  const scan = (code: string, token: string = kiosk.token) =>
    api.inject({
      method: "POST",
      url: "/v1/kiosk/check-ins",
      headers: { "x-kiosk-token": token },
      payload: { code },
    });
  const desk = (branchId: string, memberId = t.member.id, headers = t.g.owner.headers) =>
    api.inject({
      method: "POST",
      url: `${t.g.base}/branches/${branchId}/check-ins`,
      headers,
      payload: { memberId },
    });
  return { ...t, planId, membership: enrolled.json(), kiosk, scan, desk };
}

describe("checking in", () => {
  it("lets a member in with their QR code once per code, without counting them twice", async () => {
    const t = await readyToEnter();
    const now = new Date();
    const first = await t.scan(t.qr(now));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      allowed: true,
      reason: null,
      member: { id: t.member.id, name: "Asha" },
      visit: { method: "qr", branchId: t.g.branch.id, checkedOutAt: null },
    });
    expect((await t.scan(t.qr(now))).json()).toMatchObject({
      allowed: false,
      reason: "code_already_used",
      member: null,
    });
    const again = (await t.scan(t.qr(new Date(now.getTime() + 30_000)))).json();
    expect(again.visit.id).toBe(first.json().visit.id);
    expect((await t.scan("nonsense")).json()).toMatchObject({ reason: "invalid_code" });
    expect((await t.scan(t.qr(now), "kio.bad")).statusCode).toBe(401);
  });

  it("turns members away with the reason: no membership, paused, wrong branch, unpaid dues", async () => {
    const noPlan = await memberWithPass();
    const kiosk = (
      await noPlan.g.call("POST", `${noPlan.g.base}/branches/${noPlan.g.branch.id}/kiosks`, {
        name: "Door",
      })
    ).json();
    const denied = await api.inject({
      method: "POST",
      url: "/v1/kiosk/check-ins",
      headers: { "x-kiosk-token": kiosk.token },
      payload: { code: noPlan.qr(new Date()) },
    });
    expect(denied.json()).toMatchObject({
      allowed: false,
      reason: "no_active_membership",
      member: { id: noPlan.member.id },
      visit: null,
    });

    const paused = await readyToEnter();
    await withTenant(dbh.db, paused.orgId, (tx) =>
      tx
        .update(memberships)
        .set({ status: "frozen" })
        .where(eq(memberships.id, paused.membership.id)),
    );
    expect((await paused.desk(paused.g.branch.id)).json().reason).toBe("membership_paused");

    const local = await readyToEnter();
    const other = (
      await local.g.call("POST", `${local.g.base}/branches`, { name: "Second", city: "Pune" })
    ).json();
    await local.g.call("PATCH", `${local.g.base}/plans/${local.planId}`, {
      branchIds: [local.g.branch.id],
    });
    expect((await local.desk(other.id)).json().reason).toBe("wrong_branch");
    expect((await local.desk(local.g.branch.id)).json().allowed).toBe(true);

    const owing = await readyToEnter();
    await vi.waitFor(
      async () => {
        const list = (
          await owing.g.call("GET", `${owing.g.base}/members/${owing.member.id}/invoices`)
        ).json();
        expect(list).toHaveLength(1);
      },
      { timeout: 15_000, interval: 100 },
    );
    await withTenant(dbh.db, owing.orgId, (tx) =>
      tx
        .update(invoices)
        .set({ dueDate: addDays(new Date().toISOString().slice(0, 10), -3) })
        .where(eq(invoices.memberId, owing.member.id)),
    );
    expect((await owing.desk(owing.g.branch.id)).json().reason).toBe("dues_unpaid");
  });

  it("front desk can check members in at their branches; trainers and other gyms cannot", async () => {
    const t = await readyToEnter();
    const desk = await t.g.staff("front_desk");
    expect((await t.desk(t.g.branch.id, t.member.id, desk.headers)).json()).toMatchObject({
      allowed: true,
      visit: { method: "desk" },
    });
    const trainer = await t.g.staff("trainer");
    expect((await t.desk(t.g.branch.id, t.member.id, trainer.headers)).statusCode).toBe(403);
    const elsewhere = await gymWithMember(api, dbh.db);
    expect((await t.desk(t.g.branch.id, elsewhere.member.id)).statusCode).toBe(404);
    const other = (
      await t.g.call("POST", `${t.g.base}/branches`, { name: "Second", city: "Pune" })
    ).json();
    const sideDesk = await t.g.staff("front_desk", [other.id]);
    expect((await t.desk(t.g.branch.id, t.member.id, sideDesk.headers)).statusCode).toBe(404);
  });

  it("moves a member who walks into another branch, and records leaving", async () => {
    const t = await readyToEnter();
    const other = (
      await t.g.call("POST", `${t.g.base}/branches`, { name: "Second", city: "Pune" })
    ).json();
    const first = (await t.desk(t.g.branch.id)).json().visit;
    const second = (await t.desk(other.id)).json().visit;
    expect(second.id).not.toBe(first.id);
    const history = (await t.g.call("GET", `${t.g.base}/members/${t.member.id}/check-ins`)).json();
    expect(history.map((v: { id: string }) => v.id)).toEqual([second.id, first.id]);
    expect(history[1].checkedOutAt).not.toBeNull();

    const out = await t.g.call("POST", `${t.g.base}/check-ins/${second.id}/check-out`);
    expect(out.json().checkedOutAt).not.toBeNull();
    const twice = await t.g.call("POST", `${t.g.base}/check-ins/${second.id}/check-out`);
    expect(twice.json().checkedOutAt).toBe(out.json().checkedOutAt);
  });

  it("lets members check themselves out and see their visits", async () => {
    const t = await readyToEnter();
    const visit = (await t.desk(t.g.branch.id)).json().visit;
    const url = `/v1/me/gyms/${t.orgId}`;
    const out = await api.inject({
      method: "POST",
      url: `${url}/check-out`,
      headers: t.me.headers,
    });
    expect(out.json()).toMatchObject({ id: visit.id });
    expect(out.json().checkedOutAt).not.toBeNull();
    expect(
      (await api.inject({ method: "POST", url: `${url}/check-out`, headers: t.me.headers }))
        .statusCode,
    ).toBe(404);
    expect((await get(`${url}/check-ins`, t.me.headers)).json()).toHaveLength(1);
  });

  it("many simultaneous check-ins of one member make one visit", async () => {
    const t = await readyToEnter();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => t.desk(t.g.branch.id).then((r) => r.json())),
    );
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(new Set(results.map((r) => r.visit.id)).size).toBe(1);
  });
});

const countAt = (body: { branches: { branchId: string; count: number }[] }, branchId: string) =>
  body.branches.find((b) => b.branchId === branchId)?.count;

describe("how busy each branch is", () => {
  it("counts members inside per branch for staff and members, and publishes each change", async () => {
    const t = await readyToEnter();
    const friend = await memberWithPhone(t.g, randomPhone(), "Ravi");
    await t.g.call("POST", `${t.g.base}/members/${friend.id}/memberships`, { planId: t.planId });
    const other = (
      await t.g.call("POST", `${t.g.base}/branches`, { name: "Second", city: "Pune" })
    ).json();
    const mine = (await t.desk(t.g.branch.id)).json().visit;
    await t.desk(t.g.branch.id, friend.id);

    const staffView = (await t.g.call("GET", `${t.g.base}/occupancy`)).json();
    expect(countAt(staffView, t.g.branch.id)).toBe(2);
    expect(countAt(staffView, other.id)).toBe(0);
    const memberView = (await get(`/v1/me/gyms/${t.orgId}/occupancy`, t.me.headers)).json();
    expect(countAt(memberView, t.g.branch.id)).toBe(2);

    await t.g.call("POST", `${t.g.base}/check-ins/${mine.id}/check-out`);
    expect(countAt((await t.g.call("GET", `${t.g.base}/occupancy`)).json(), t.g.branch.id)).toBe(1);

    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, t.orgId))
      .orderBy(asc(outboxEvents.id));
    const counts = events
      .filter((e) => e.type === "branch.occupancy_changed")
      .map((e) => (e.payload as { count: number }).count);
    expect(counts).toEqual([1, 2, 1]);

    const sideTrainer = await t.g.staff("trainer", [other.id]);
    const trainerView = (
      await api.inject({
        method: "GET",
        url: `${t.g.base}/occupancy`,
        headers: sideTrainer.headers,
      })
    ).json();
    expect(trainerView.branches.map((b: { branchId: string }) => b.branchId)).toEqual([other.id]);
  });

  it("stops counting a member who never checked out, and the hourly job records them leaving", async () => {
    const t = await readyToEnter();
    const visit = (await t.desk(t.g.branch.id)).json().visit;
    const fourHoursAgo = new Date(Date.now() - 4 * 3_600_000);
    await withTenant(dbh.db, t.orgId, (tx) =>
      tx.update(checkIns).set({ checkedInAt: fourHoursAgo }).where(eq(checkIns.id, visit.id)),
    );
    expect(countAt((await t.g.call("GET", `${t.g.base}/occupancy`)).json(), t.g.branch.id)).toBe(0);

    expect((await runAutoCheckOut(dbh.db, 3)).checkedOut).toBeGreaterThanOrEqual(1);
    await runAutoCheckOut(dbh.db, 3);
    const [ended] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(checkIns).where(eq(checkIns.id, visit.id)),
    );
    expect(ended?.checkedOutAt?.getTime()).toBe(fourHoursAgo.getTime() + 3 * 3_600_000);
    const keys = (await worker.maintenanceQueue.getJobSchedulers()).map((k) => k.key);
    expect(keys).toContain("auto-check-out-hourly");
  });

  it(
    "counts exactly 1,000 members checking in at the same time",
    { timeout: 120_000 },
    async () => {
      const g = await gymWithMember(api, dbh.db);
      const orgId = g.base.split("/").at(-1) ?? "";
      const plan = await g.plan({});
      const today = new Date().toISOString().slice(0, 10);
      const ids = await withTenant(dbh.db, orgId, async (tx) => {
        const people = await tx
          .insert(members)
          .values(
            Array.from({ length: 1000 }, (_, i) => ({
              tenantId: orgId,
              name: `Member ${i}`,
              homeBranchId: g.branch.id,
            })),
          )
          .returning({ id: members.id });
        await tx.insert(memberships).values(
          people.map((p) => ({
            tenantId: orgId,
            memberId: p.id,
            planId: plan.id,
            planName: "Monthly",
            status: "active" as const,
            startDate: today,
            endDate: addDays(today, 29),
            isTrial: false,
            pricePaise: 0,
            joiningFeePaise: 0,
            gstRateBps: 0,
            gstPaise: 0,
            totalPaise: 0,
            maxFreezes: 0,
            maxFreezeDays: 0,
          })),
        );
        return people.map((p) => p.id);
      });
      const results = await Promise.all(
        ids.map((memberId) =>
          api
            .inject({
              method: "POST",
              url: `${g.base}/branches/${g.branch.id}/check-ins`,
              headers: g.owner.headers,
              payload: { memberId },
            })
            .then((r) => r.json()),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(1000);
      expect(countAt((await g.call("GET", `${g.base}/occupancy`)).json(), g.branch.id)).toBe(1000);
    },
  );
});
