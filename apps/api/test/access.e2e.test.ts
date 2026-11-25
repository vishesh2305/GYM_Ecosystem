import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { members } from "@gym/db/schema";
import { Secret, TOTP } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPassCode } from "../src/access/passes";
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
