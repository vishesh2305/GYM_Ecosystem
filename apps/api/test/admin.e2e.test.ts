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
