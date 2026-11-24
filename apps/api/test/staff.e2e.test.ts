import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { staffInvites } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ConsoleEmailSender, ConsoleSmsSender } from "../src/auth/senders";
import { EMAIL_SENDER, SMS_SENDER } from "../src/tokens";
import { signedInStaff, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let sms: ConsoleSmsSender;
let mail: ConsoleEmailSender;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv({ APP_URL: "https://app.gym.test" })));
  dbh = createDb(testEnv().DATABASE_URL);
  sms = api.get(SMS_SENDER);
  mail = api.get(EMAIL_SENDER);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

type Headers = Record<string, string>;
const req = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Headers,
  payload?: object,
) => api.inject({ method, url, headers, ...(payload && { payload }) });
const randomPhone = () => `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const tokenIn = (text = "") => /\/invite\/([\w.-]+)/.exec(text)?.[1] ?? "";

async function gym() {
  const owner = await signedInStaff(api, dbh.db, { name: "Owner" });
  const res = await req("POST", "/v1/orgs", owner.headers, {
    name: "Pulse Gym",
    branch: { name: "Aundh", city: "Pune" },
  });
  const org = res.json().organisation;
  return { owner, org, branch: res.json().branch, base: `/v1/orgs/${org.id}` };
}

async function inviteBySms(
  g: Awaited<ReturnType<typeof gym>>,
  role: string,
  headers = g.owner.headers,
) {
  const phone = randomPhone();
  const res = await req("POST", `${g.base}/invites`, headers, { channel: "sms", phone, role });
  return { res, phone, token: tokenIn(sms.sent.at(-1)?.text) };
}

describe("inviting staff", () => {
  it("an SMS invite with a link; the invited person accepts and gets the role", async () => {
    const g = await gym();
    const { res, phone, token } = await inviteBySms(g, "front_desk");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "front_desk", destination: phone });
    expect(sms.sent.at(-1)?.text).toMatch(/Pulse Gym/);
    expect(sms.sent.at(-1)?.text).toContain("https://app.gym.test/invite/");

    const invitee = await signedInStaff(api, dbh.db, { name: "Desk Person", phone });
    const accepted = await req("POST", "/v1/invites/accept", invitee.headers, { token });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: g.org.id, myRole: "front_desk" });

    const staff = (await req("GET", `${g.base}/staff`, g.owner.headers)).json() as {
      name: string;
      role: string;
    }[];
    expect(staff.map((s) => [s.name, s.role]).sort()).toEqual([
      ["Desk Person", "front_desk"],
      ["Owner", "owner"],
    ]);
  });

  it("works by email too", async () => {
    const g = await gym();
    const email = `trainer.${Date.now()}@example.com`;
    expect(
      (
        await req("POST", `${g.base}/invites`, g.owner.headers, {
          channel: "email",
          email,
          role: "trainer",
        })
      ).statusCode,
    ).toBe(201);
    const invitee = await signedInStaff(api, dbh.db, { email });
    const res = await req("POST", "/v1/invites/accept", invitee.headers, {
      token: tokenIn(mail.sent.at(-1)?.text),
    });
    expect(res.json().myRole).toBe("trainer");
  });

  it("only the person it was sent to can accept it, and only once", async () => {
    const g = await gym();
    const { phone, token } = await inviteBySms(g, "trainer");
    const someoneElse = await signedInStaff(api, dbh.db, { phone: randomPhone() });
    expect(
      (await req("POST", "/v1/invites/accept", someoneElse.headers, { token })).statusCode,
    ).toBe(403);
    const invitee = await signedInStaff(api, dbh.db, { phone });
    expect((await req("POST", "/v1/invites/accept", invitee.headers, { token })).statusCode).toBe(
      200,
    );
    expect((await req("POST", "/v1/invites/accept", invitee.headers, { token })).statusCode).toBe(
      400,
    );
  });

  it("expired, revoked, forged or unknown invites do not work", async () => {
    const g = await gym();
    const expired = await inviteBySms(g, "trainer");
    await withTenant(dbh.db, g.org.id, (tx) =>
      tx
        .update(staffInvites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(staffInvites.id, expired.res.json().id)),
    );
    const a = await signedInStaff(api, dbh.db, { phone: expired.phone });
    expect(
      (await req("POST", "/v1/invites/accept", a.headers, { token: expired.token })).json().detail,
    ).toMatch(/expired/);

    const revoked = await inviteBySms(g, "trainer");
    expect(
      (await req("DELETE", `${g.base}/invites/${revoked.res.json().id}`, g.owner.headers))
        .statusCode,
    ).toBe(204);
    const b = await signedInStaff(api, dbh.db, { phone: revoked.phone });
    expect(
      (await req("POST", "/v1/invites/accept", b.headers, { token: revoked.token })).statusCode,
    ).toBe(400);

    const forged = `${g.org.id}.${"x".repeat(43)}`;
    expect((await req("POST", "/v1/invites/accept", b.headers, { token: forged })).statusCode).toBe(
      404,
    );
    expect(
      (await req("POST", "/v1/invites/accept", b.headers, { token: "nonsense-token-value" }))
        .statusCode,
    ).toBe(404);
  });

  it("lists pending invites", async () => {
    const g = await gym();
    await inviteBySms(g, "trainer");
    await inviteBySms(g, "front_desk");
    const pending = (await req("GET", `${g.base}/invites`, g.owner.headers)).json();
    expect(pending.map((i: { role: string }) => i.role).sort()).toEqual(["front_desk", "trainer"]);
  });
});

describe("who may invite whom", () => {
  it("managers invite front desk and trainers but not managers or owners; front desk cannot invite", async () => {
    const g = await gym();
    const m = await inviteBySms(g, "manager");
    const manager = await signedInStaff(api, dbh.db, { phone: m.phone });
    await req("POST", "/v1/invites/accept", manager.headers, { token: m.token });

    expect((await inviteBySms(g, "trainer", manager.headers)).res.statusCode).toBe(201);
    expect((await inviteBySms(g, "manager", manager.headers)).res.statusCode).toBe(403);
    expect((await inviteBySms(g, "owner", manager.headers)).res.statusCode).toBe(403);

    const d = await inviteBySms(g, "front_desk");
    const desk = await signedInStaff(api, dbh.db, { phone: d.phone });
    await req("POST", "/v1/invites/accept", desk.headers, { token: d.token });
    expect((await inviteBySms(g, "trainer", desk.headers)).res.statusCode).toBe(403);
  });

  it("branches must belong to this gym, and existing staff cannot be invited again", async () => {
    const g = await gym();
    const other = await gym();
    const bad = await req("POST", `${g.base}/invites`, g.owner.headers, {
      channel: "sms",
      phone: randomPhone(),
      role: "trainer",
      branchIds: [other.branch.id],
    });
    expect(bad.statusCode).toBe(400);

    const ownerPhone = randomPhone();
    const owner2 = await signedInStaff(api, dbh.db, { phone: ownerPhone });
    const t = await inviteBySms(g, "manager");
    void owner2;
    const joined = await signedInStaff(api, dbh.db, { phone: t.phone });
    await req("POST", "/v1/invites/accept", joined.headers, { token: t.token });
    const again = await req("POST", `${g.base}/invites`, g.owner.headers, {
      channel: "sms",
      phone: t.phone,
      role: "trainer",
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("managing staff", () => {
  it("the owner changes roles and removes staff, who then lose access", async () => {
    const g = await gym();
    const t = await inviteBySms(g, "trainer");
    const trainer = await signedInStaff(api, dbh.db, { phone: t.phone });
    await req("POST", "/v1/invites/accept", trainer.headers, { token: t.token });
    const staffId = (
      (await req("GET", `${g.base}/staff`, g.owner.headers)).json() as {
        id: string;
        role: string;
      }[]
    ).find((s) => s.role === "trainer")?.id;

    const promoted = await req("PATCH", `${g.base}/staff/${staffId}`, g.owner.headers, {
      role: "manager",
    });
    expect(promoted.json().role).toBe("manager");
    expect((await req("DELETE", `${g.base}/staff/${staffId}`, g.owner.headers)).statusCode).toBe(
      204,
    );
    expect((await req("GET", g.base, trainer.headers)).statusCode).toBe(404);
  });

  it("staff can only be given branches of this gym", async () => {
    const g = await gym();
    const other = await gym();
    const ownerStaff = (
      (await req("GET", `${g.base}/staff`, g.owner.headers)).json() as { id: string }[]
    )[0]?.id;
    const res = await req("PATCH", `${g.base}/staff/${ownerStaff}`, g.owner.headers, {
      branchIds: [other.branch.id],
    });
    expect(res.statusCode).toBe(400);
  });

  it("the last owner can never be removed, demoted or suspended", async () => {
    const g = await gym();
    const ownerStaff = (
      (await req("GET", `${g.base}/staff`, g.owner.headers)).json() as { id: string }[]
    )[0]?.id;
    expect(
      (await req("PATCH", `${g.base}/staff/${ownerStaff}`, g.owner.headers, { role: "manager" }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await req("PATCH", `${g.base}/staff/${ownerStaff}`, g.owner.headers, {
          status: "suspended",
        })
      ).statusCode,
    ).toBe(409);
    expect((await req("DELETE", `${g.base}/staff/${ownerStaff}`, g.owner.headers)).statusCode).toBe(
      409,
    );
  });

  it("managers can see the staff list but not change it", async () => {
    const g = await gym();
    const m = await inviteBySms(g, "manager");
    const manager = await signedInStaff(api, dbh.db, { phone: m.phone });
    await req("POST", "/v1/invites/accept", manager.headers, { token: m.token });
    const list = (await req("GET", `${g.base}/staff`, manager.headers)).json() as { id: string }[];
    expect(list).toHaveLength(2);
    expect(
      (await req("PATCH", `${g.base}/staff/${list[0]?.id}`, manager.headers, { role: "trainer" }))
        .statusCode,
    ).toBe(403);
  });
});
