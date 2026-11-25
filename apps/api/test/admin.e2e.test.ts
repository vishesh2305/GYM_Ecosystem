import { createDb, withUser, type DbHandle } from "@gym/db";
import { and, eq } from "@gym/db/orm";
import { auditLog, platformAdmins } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { FeatureFlags } from "../src/platform/feature-flags.service";
import { gymWithMember, signedInStaff, signedInUser, testEnv } from "./helpers";

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

/** A platform admin, signed in with two-step verification. Admins are only ever added in the database. */
async function admin() {
  const person = await signedInStaff(api, dbh.db, { name: "Platform admin" });
  await dbh.db.insert(platformAdmins).values({ userId: person.user.id, note: "test" });
  return person;
}

describe("platform admin console", () => {
  it("is only for platform admins who used two-step verification", async () => {
    const stranger = await signedInStaff(api, dbh.db);
    const get = (headers: Record<string, string>) =>
      api.inject({ method: "GET", url: "/v1/admin/gyms", headers });
    expect((await get(stranger.headers)).statusCode).toBe(403);
    const noMfa = await signedInUser(api, dbh.db);
    await dbh.db.insert(platformAdmins).values({ userId: noMfa.user.id });
    expect((await get(noMfa.headers)).statusCode).toBe(403);
    expect((await get((await admin()).headers)).statusCode).toBe(200);
    expect((await api.inject({ method: "GET", url: "/v1/admin/gyms" })).statusCode).toBe(401);
  });

  it("nobody can make themselves a platform admin", async () => {
    const someone = await signedInUser(api, dbh.db);
    await expect(
      withUser(dbh.db, someone.user.id, (tx) =>
        tx.insert(platformAdmins).values({ userId: someone.user.id }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("lists gyms with their size, owners and onboarding status, and records KYC reviews", async () => {
    const me = await admin();
    const g = await gymWithMember(api, dbh.db);
    await g.call("PATCH", g.base, { name: `Kyc Gym ${Date.now()}` });
    const as = (method: string, url: string, payload?: object) =>
      api.inject({ method, url, headers: me.headers, ...(payload && { payload }) });

    const pending = (await as("GET", "/v1/admin/gyms?kycStatus=pending&q=kyc%20gym")).json() as {
      id: string;
      members: number;
      branches: number;
      owners: { name: string }[];
    }[];
    const gym = pending.find((p) => p.id === orgOf(g));
    expect(gym).toMatchObject({
      members: 1,
      branches: 1,
      owners: [expect.objectContaining({ name: "Test person" })],
    });

    const reviewed = await as("PATCH", `/v1/admin/gyms/${orgOf(g)}/kyc`, {
      status: "verified",
      note: "GSTIN checked",
    });
    expect(reviewed.json()).toMatchObject({ kycStatus: "verified", kycNote: "GSTIN checked" });
    expect((await g.call("GET", g.base)).json().kycStatus).toBe("verified");
    const [entry] = await dbh.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "organisation.kyc_reviewed"), eq(auditLog.entityId, orgOf(g))),
      );
    expect(entry).toMatchObject({ actorType: "admin", actorId: me.user.id });

    expect(
      (await as("PATCH", `/v1/admin/gyms/${crypto.randomUUID()}/kyc`, { status: "verified" }))
        .statusCode,
    ).toBe(404);
  });

  it("switches features on for chosen gyms at once", async () => {
    const me = await admin();
    const g = await gymWithMember(api, dbh.db);
    const key = `beta.reports_${Date.now()}`;
    const flags = api.get(FeatureFlags);
    expect(await flags.isEnabled(key, { tenantId: orgOf(g) })).toBe(false);
    const res = await api.inject({
      method: "PUT",
      url: `/v1/admin/flags/${key}`,
      headers: me.headers,
      payload: {
        description: "New reports",
        enabled: false,
        rolloutPercent: 0,
        tenantIds: [orgOf(g)],
        userIds: [],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await flags.isEnabled(key, { tenantId: orgOf(g) })).toBe(true);
    expect(await flags.isEnabled(key, { tenantId: crypto.randomUUID() })).toBe(false);
    const list = (
      await api.inject({ method: "GET", url: "/v1/admin/flags", headers: me.headers })
    ).json() as { key: string }[];
    expect(list.map((f) => f.key)).toContain(key);
  });
});

describe("support access", () => {
  async function setUp() {
    const g = await gymWithMember(api, dbh.db);
    const support = await admin();
    const look = (method: string, path: string, payload?: object) =>
      api.inject({
        method,
        url: `${g.base}${path}`,
        headers: support.headers,
        ...(payload && { payload }),
      });
    return { g, support, look };
  }

  it("lets support read a gym only while the owner allows it, and never change anything", async () => {
    const { g, support, look } = await setUp();
    expect((await look("GET", "/members")).statusCode).toBe(404);

    const granted = await g.call("POST", `${g.base}/support-access`, {
      hours: 2,
      reason: "Invoices look wrong",
    });
    expect(granted.statusCode).toBe(201);
    const grantId = granted.json().id as string;

    const members = await look("GET", "/members");
    expect(members.statusCode).toBe(200);
    expect(members.json().items.map((m: { name: string }) => m.name)).toEqual(["Member"]);
    expect(
      (await look("POST", "/members", { name: "Added by support", homeBranchId: g.branch.id }))
        .statusCode,
    ).toBe(403);
    expect((await look("PATCH", "", { name: "Renamed by support" })).statusCode).toBe(403);

    // The owner sees that support looked, and every look is in the audit log.
    const grants = (await g.call("GET", `${g.base}/support-access`)).json() as { views: number }[];
    expect(grants[0]?.views).toBe(1); // the refused changes are not looks
    const trail = await dbh.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "support.viewed"), eq(auditLog.actorId, support.user.id)));
    expect(trail.map((t) => (t.data as { path: string }).path)).toEqual(
      expect.arrayContaining([`${g.base}/members`]),
    );

    expect((await g.call("DELETE", `${g.base}/support-access/${grantId}`)).statusCode).toBe(204);
    expect((await look("GET", "/members")).statusCode).toBe(404);
  });

  it("ends when the grant expires, opens only that gym, and needs a platform admin", async () => {
    const { g, look, support } = await setUp();
    const other = await gymWithMember(api, dbh.db);
    await g.call("POST", `${g.base}/support-access`, { hours: 1, reason: "Check classes" });
    expect((await look("GET", "/branches")).statusCode).toBe(200);
    const elsewhere = await api.inject({
      method: "GET",
      url: `${other.base}/branches`,
      headers: support.headers,
    });
    expect(elsewhere.statusCode).toBe(404);
    const notAdmin = await signedInStaff(api, dbh.db);
    const tried = await api.inject({
      method: "GET",
      url: `${g.base}/branches`,
      headers: notAdmin.headers,
    });
    expect(tried.statusCode).toBe(404);

    await dbh.pool.query(
      "update support_grants set expires_at = now() - interval '1 minute' where tenant_id = $1",
      [orgOf(g)],
    );
    expect((await look("GET", "/branches")).statusCode).toBe(404);
  });

  it("can be granted only by an owner", async () => {
    const g = await gymWithMember(api, dbh.db);
    const desk = await g.staff("front_desk");
    const res = await api.inject({
      method: "POST",
      url: `${g.base}/support-access`,
      headers: desk.headers,
      payload: { hours: 1, reason: "Please help" },
    });
    expect(res.statusCode).toBe(403);
  });
});
