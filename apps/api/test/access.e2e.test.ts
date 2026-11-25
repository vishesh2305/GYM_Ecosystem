import { createDb, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { members } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
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
