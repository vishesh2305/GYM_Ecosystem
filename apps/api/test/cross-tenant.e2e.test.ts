import { routes, type Route } from "@gym/contracts";
import { createDb, withTenant, type DbHandle } from "@gym/db";
import { branches, organisations, staffInvites, staffMembers } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
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
  updateBranch: { name: "Renamed by intruder" },
  inviteStaff: { channel: "sms", phone: "+919000000001", role: "trainer" },
  updateStaff: { role: "trainer" },
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
      headers: attackerHeaders,
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
        headers: attackerHeaders,
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
  });
});
