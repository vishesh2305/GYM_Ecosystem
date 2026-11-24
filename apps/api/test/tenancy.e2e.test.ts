import { createDb, withTenant, type DbHandle } from "@gym/db";
import { staffMembers } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signedInUser, testEnv } from "./helpers";

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

type Headers = Record<string, string>;
const post = (url: string, headers: Headers, payload: object) =>
  api.inject({ method: "POST", url, headers, payload });
const patch = (url: string, headers: Headers, payload: object) =>
  api.inject({ method: "PATCH", url, headers, payload });
const get = (url: string, headers: Headers) => api.inject({ method: "GET", url, headers });

async function ownerWithGym(name = "Iron Temple") {
  const owner = await signedInUser(api, dbh.db, { name: "Owner" });
  const res = await post("/v1/orgs", owner.headers, {
    name,
    gstin: "27AAPFU0939F1ZV",
    branch: { name: "Koregaon Park", city: "Pune", state: "Maharashtra" },
  });
  expect(res.statusCode).toBe(201);
  return { owner, org: res.json().organisation, branch: res.json().branch };
}

describe("registering a gym business", () => {
  it("creates the business and its first branch; the creator becomes owner", async () => {
    const { owner, org, branch } = await ownerWithGym();
    expect(org).toMatchObject({
      name: "Iron Temple",
      gstin: "27AAPFU0939F1ZV",
      currency: "INR",
      timezone: "Asia/Kolkata",
      myRole: "owner",
    });
    expect(branch).toMatchObject({ name: "Koregaon Park", city: "Pune" });

    const mine = (await get("/v1/orgs", owner.headers)).json();
    expect(mine.map((o: { id: string }) => o.id)).toContain(org.id);
    expect((await get(`/v1/orgs/${org.id}`, owner.headers)).json().id).toBe(org.id);
  });

  it("rejects an invalid GSTIN or time zone", async () => {
    const someone = await signedInUser(api, dbh.db);
    const base = { name: "Gym", branch: { name: "Main", city: "Pune" } };
    expect((await post("/v1/orgs", someone.headers, { ...base, gstin: "123" })).statusCode).toBe(
      400,
    );
    expect(
      (await post("/v1/orgs", someone.headers, { ...base, timezone: "Mars/Olympus" })).statusCode,
    ).toBe(400);
  });

  it("only the owner can change the business details", async () => {
    const { owner, org } = await ownerWithGym();
    const renamed = await patch(`/v1/orgs/${org.id}`, owner.headers, {
      name: "Iron Temple Fitness",
    });
    expect(renamed.json().name).toBe("Iron Temple Fitness");

    const manager = await signedInUser(api, dbh.db);
    await withTenant(dbh.db, org.id, (tx) =>
      tx
        .insert(staffMembers)
        .values({ tenantId: org.id, userId: manager.user.id, role: "manager" }),
    );
    expect(
      (await patch(`/v1/orgs/${org.id}`, manager.headers, { name: "Mine now" })).statusCode,
    ).toBe(403);
    expect((await get(`/v1/orgs/${org.id}`, manager.headers)).json().myRole).toBe("manager");
  });
});

describe("other people's gyms do not exist for you", () => {
  it("someone who does not work at a gym gets 404, not 403", async () => {
    const { org } = await ownerWithGym();
    const stranger = await signedInUser(api, dbh.db);
    expect((await get(`/v1/orgs/${org.id}`, stranger.headers)).statusCode).toBe(404);
    expect((await patch(`/v1/orgs/${org.id}`, stranger.headers, { name: "x" })).statusCode).toBe(
      404,
    );
    expect((await get(`/v1/orgs/${org.id}/branches`, stranger.headers)).statusCode).toBe(404);
    expect((await get("/v1/orgs/not-a-uuid", stranger.headers)).statusCode).toBe(404);
  });

  it("a suspended staff member loses access", async () => {
    const { org } = await ownerWithGym();
    const former = await signedInUser(api, dbh.db);
    await withTenant(dbh.db, org.id, (tx) =>
      tx.insert(staffMembers).values({
        tenantId: org.id,
        userId: former.user.id,
        role: "front_desk",
        status: "suspended",
      }),
    );
    expect((await get(`/v1/orgs/${org.id}`, former.headers)).statusCode).toBe(404);
  });
});

describe("branches", () => {
  it("owners and managers open and edit branches; everyone on staff can list them", async () => {
    const { owner, org } = await ownerWithGym();
    const second = await post(`/v1/orgs/${org.id}/branches`, owner.headers, {
      name: "Baner",
      city: "Pune",
    });
    expect(second.statusCode).toBe(201);
    const edited = await patch(`/v1/orgs/${org.id}/branches/${second.json().id}`, owner.headers, {
      phone: "+912012345678",
    });
    expect(edited.json().phone).toBe("+912012345678");

    const desk = await signedInUser(api, dbh.db);
    await withTenant(dbh.db, org.id, (tx) =>
      tx
        .insert(staffMembers)
        .values({ tenantId: org.id, userId: desk.user.id, role: "front_desk" }),
    );
    expect((await get(`/v1/orgs/${org.id}/branches`, desk.headers)).json()).toHaveLength(2);
    expect(
      (await post(`/v1/orgs/${org.id}/branches`, desk.headers, { name: "X", city: "Y" }))
        .statusCode,
    ).toBe(403);
  });

  it("a branch id from another gym is not found, even for an owner", async () => {
    const mine = await ownerWithGym("Mine");
    const theirs = await ownerWithGym("Theirs");
    const res = await patch(
      `/v1/orgs/${mine.org.id}/branches/${theirs.branch.id}`,
      mine.owner.headers,
      { name: "Stolen" },
    );
    expect(res.statusCode).toBe(404);
  });
});
