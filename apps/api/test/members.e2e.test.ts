import { createDb, type DbHandle } from "@gym/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ConsoleSmsSender } from "../src/auth/senders";
import { SMS_SENDER } from "../src/tokens";
import { signedInStaff, testEnv } from "./helpers";

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
const req = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  api.inject({ method, url, headers, ...(payload && { payload }) });
const randomLocal = () => `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function gym() {
  const owner = await signedInStaff(api, dbh.db);
  const res = (
    await req("POST", "/v1/orgs", owner.headers, {
      name: "Member Gym",
      branch: { name: "Main", city: "Pune" },
    })
  ).json();
  const base = `/v1/orgs/${res.organisation.id}`;
  const join = async (role: string, branchIds: string[] = []) => {
    const sms = api.get<ConsoleSmsSender>(SMS_SENDER);
    const phone = `+91${randomLocal()}`;
    await req("POST", `${base}/invites`, owner.headers, { channel: "sms", phone, role, branchIds });
    const person = await signedInStaff(api, dbh.db, { phone });
    await req("POST", "/v1/invites/accept", person.headers, {
      token: /\/invite\/([\w.-]+)/.exec(sms.sent.at(-1)?.text ?? "")?.[1],
    });
    return person;
  };
  return { owner, base, branch: res.branch, join };
}

describe("member records", () => {
  it("front desk adds a member; the phone number is stored in international format", async () => {
    const g = await gym();
    const desk = await g.join("front_desk");
    const local = randomLocal();
    const res = await req("POST", `${g.base}/members`, desk.headers, {
      name: "Priya Sharma",
      phone: local,
      email: "Priya@Example.com",
      gender: "female",
      dateOfBirth: "1995-04-12",
      homeBranchId: g.branch.id,
      emergencyContactName: "Rahul Sharma",
      emergencyContactPhone: "98000 00000",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: "Priya Sharma",
      phone: `+91${local}`,
      email: "priya@example.com",
      emergencyContactPhone: "+919800000000",
      source: "manual",
    });
    const got = await req("GET", `${g.base}/members/${res.json().id}`, desk.headers);
    expect(got.json().name).toBe("Priya Sharma");
  });

  it("refuses a second member with the same phone number in one gym", async () => {
    const g = await gym();
    const phone = randomLocal();
    const body = { name: "A", phone, homeBranchId: g.branch.id };
    expect((await req("POST", `${g.base}/members`, g.owner.headers, body)).statusCode).toBe(201);
    const dup = await req("POST", `${g.base}/members`, g.owner.headers, { ...body, name: "B" });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects a birth date in the future, a bad phone, or a branch from another gym", async () => {
    const g = await gym();
    const other = await gym();
    const base = { name: "X", homeBranchId: g.branch.id };
    expect(
      (
        await req("POST", `${g.base}/members`, g.owner.headers, {
          ...base,
          dateOfBirth: "2999-01-01",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await req("POST", `${g.base}/members`, g.owner.headers, { ...base, phone: "12" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await req("POST", `${g.base}/members`, g.owner.headers, {
          ...base,
          homeBranchId: other.branch.id,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("updates only what was sent", async () => {
    const g = await gym();
    const m = (
      await req("POST", `${g.base}/members`, g.owner.headers, {
        name: "Old",
        email: "a@b.co",
        homeBranchId: g.branch.id,
      })
    ).json();
    const updated = (
      await req("PATCH", `${g.base}/members/${m.id}`, g.owner.headers, { name: "New" })
    ).json();
    expect(updated).toMatchObject({ name: "New", email: "a@b.co" });
  });
});

describe("finding members", () => {
  it("searches by name or phone and pages through results, newest first", async () => {
    const g = await gym();
    const phones = [randomLocal(), randomLocal(), randomLocal()];
    for (const [i, name] of ["Aarav Patel", "Diya Patel", "Kabir Singh"].entries()) {
      await req("POST", `${g.base}/members`, g.owner.headers, {
        name,
        phone: phones[i],
        homeBranchId: g.branch.id,
      });
    }
    const byName = (await req("GET", `${g.base}/members?q=patel`, g.owner.headers)).json();
    expect(byName.items.map((m: { name: string }) => m.name)).toEqual([
      "Diya Patel",
      "Aarav Patel",
    ]);
    const byPhone = (
      await req("GET", `${g.base}/members?q=${phones[2]?.slice(-6)}`, g.owner.headers)
    ).json();
    expect(byPhone.items.map((m: { name: string }) => m.name)).toEqual(["Kabir Singh"]);
    expect(
      (await req("GET", `${g.base}/members?q=${encodeURIComponent("%")}`, g.owner.headers)).json()
        .items,
    ).toEqual([]);

    const page1 = (await req("GET", `${g.base}/members?limit=2`, g.owner.headers)).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await req("GET", `${g.base}/members?limit=2&after=${page1.nextCursor}`, g.owner.headers)
    ).json();
    expect(page2.items.map((m: { name: string }) => m.name)).toEqual(["Aarav Patel"]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe("who can see and change members", () => {
  it("trainers can look members up but not change them", async () => {
    const g = await gym();
    const trainer = await g.join("trainer");
    const m = (
      await req("POST", `${g.base}/members`, g.owner.headers, {
        name: "Client",
        homeBranchId: g.branch.id,
      })
    ).json();
    expect((await req("GET", `${g.base}/members/${m.id}`, trainer.headers)).statusCode).toBe(200);
    expect(
      (await req("PATCH", `${g.base}/members/${m.id}`, trainer.headers, { name: "X" })).statusCode,
    ).toBe(403);
    expect(
      (
        await req("POST", `${g.base}/members`, trainer.headers, {
          name: "Y",
          homeBranchId: g.branch.id,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("staff of one branch only see and add members of that branch", async () => {
    const g = await gym();
    const other = (
      await req("POST", `${g.base}/branches`, g.owner.headers, { name: "Other", city: "Pune" })
    ).json();
    const desk = await g.join("front_desk", [g.branch.id]);
    const theirs = (
      await req("POST", `${g.base}/members`, g.owner.headers, {
        name: "Other branch member",
        homeBranchId: other.id,
      })
    ).json();
    await req("POST", `${g.base}/members`, g.owner.headers, {
      name: "Main member",
      homeBranchId: g.branch.id,
    });

    const seen = (await req("GET", `${g.base}/members`, desk.headers)).json();
    expect(seen.items.map((m: { name: string }) => m.name)).toEqual(["Main member"]);
    expect((await req("GET", `${g.base}/members/${theirs.id}`, desk.headers)).statusCode).toBe(404);
    expect(
      (await req("POST", `${g.base}/members`, desk.headers, { name: "Z", homeBranchId: other.id }))
        .statusCode,
    ).toBe(403);
  });
});
