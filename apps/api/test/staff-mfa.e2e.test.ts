import { createDb, withTenant, type DbHandle } from "@gym/db";
import { staffMembers } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signedInStaff, signedInUser, testEnv } from "./helpers";

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

async function gymOwnedBy(headers: Record<string, string>) {
  const res = await api.inject({
    method: "POST",
    url: "/v1/orgs",
    headers,
    payload: { name: "Secure Gym", branch: { name: "Main", city: "Pune" } },
  });
  expect(res.statusCode).toBe(201); // registering a gym does not need two-step verification
  return res.json().organisation.id as string;
}

describe("staff must use two-step verification", () => {
  it("an owner without it is asked to turn it on; with it, they get in", async () => {
    const owner = await signedInUser(api, dbh.db);
    const orgId = await gymOwnedBy(owner.headers);
    const blocked = await api.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}`,
      headers: owner.headers,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail).toMatch(/two-step verification/i);

    const verified = await signedInStaff(api, dbh.db);
    await withTenant(dbh.db, orgId, (tx) =>
      tx.insert(staffMembers).values({ tenantId: orgId, userId: verified.user.id, role: "owner" }),
    );
    expect(
      (await api.inject({ method: "GET", url: `/v1/orgs/${orgId}`, headers: verified.headers }))
        .statusCode,
    ).toBe(200);
  });

  it("trainers are not required to use it", async () => {
    const owner = await signedInUser(api, dbh.db);
    const orgId = await gymOwnedBy(owner.headers);
    const trainer = await signedInUser(api, dbh.db);
    await withTenant(dbh.db, orgId, (tx) =>
      tx.insert(staffMembers).values({ tenantId: orgId, userId: trainer.user.id, role: "trainer" }),
    );
    expect(
      (await api.inject({ method: "GET", url: `/v1/orgs/${orgId}`, headers: trainer.headers }))
        .statusCode,
    ).toBe(200);
  });

  it("can be switched off by configuration", async () => {
    const relaxed = await createApp(testEnv({ STAFF_MFA_REQUIRED: "false" }));
    try {
      const owner = await signedInUser(relaxed.app, dbh.db);
      const res = await relaxed.app.inject({
        method: "POST",
        url: "/v1/orgs",
        headers: owner.headers,
        payload: { name: "Relaxed Gym", branch: { name: "Main", city: "Pune" } },
      });
      const orgId = res.json().organisation.id;
      expect(
        (
          await relaxed.app.inject({
            method: "GET",
            url: `/v1/orgs/${orgId}`,
            headers: owner.headers,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await relaxed.app.close();
    }
  });
});
