import { createDb, type DbHandle } from "@gym/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ConsoleSmsSender } from "../src/auth/senders";
import { SMS_SENDER } from "../src/tokens";
import { signedInUser, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let sms: ConsoleSmsSender;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  sms = api.get(SMS_SENDER);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
});

type Headers = Record<string, string>;
const req = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  api.inject({ method, url, headers, ...(payload && { payload }) });
const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

/** A gym with branches A and B, and a manager who only works at branch A. */
async function setup() {
  const owner = await signedInUser(api, dbh.db, { name: "Owner" });
  const created = await req("POST", "/v1/orgs", owner.headers, {
    name: "Two Branch Gym",
    branch: { name: "A", city: "Pune" },
  });
  const org = created.json().organisation;
  const base = `/v1/orgs/${org.id}`;
  const branchA = created.json().branch;
  const branchB = (
    await req("POST", `${base}/branches`, owner.headers, { name: "B", city: "Pune" })
  ).json();

  const join = async (role: string, branchIds: string[], name: string) => {
    const phone = randomPhone();
    await req("POST", `${base}/invites`, owner.headers, { channel: "sms", phone, role, branchIds });
    const token = /\/invite\/([\w.-]+)/.exec(sms.sent.at(-1)?.text ?? "")?.[1];
    const person = await signedInUser(api, dbh.db, { phone, name });
    await req("POST", "/v1/invites/accept", person.headers, { token });
    return person;
  };
  const managerA = await join("manager", [branchA.id], "Manager A");
  const trainerB = await join("trainer", [branchB.id], "Trainer B");
  return { owner, base, branchA, branchB, managerA, trainerB };
}

describe("staff tied to some branches", () => {
  it("only see their own branches", async () => {
    const s = await setup();
    const seen = (await req("GET", `${s.base}/branches`, s.managerA.headers)).json() as {
      id: string;
    }[];
    expect(seen.map((b) => b.id)).toEqual([s.branchA.id]);
    const ownerSees = (await req("GET", `${s.base}/branches`, s.owner.headers)).json();
    expect(ownerSees).toHaveLength(2);
  });

  it("can edit their branch but another branch does not exist for them", async () => {
    const s = await setup();
    expect(
      (
        await req("PATCH", `${s.base}/branches/${s.branchA.id}`, s.managerA.headers, {
          phone: "+912000000000",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await req("PATCH", `${s.base}/branches/${s.branchB.id}`, s.managerA.headers, {
          phone: "+912000000000",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("cannot open new branches", async () => {
    const s = await setup();
    expect(
      (await req("POST", `${s.base}/branches`, s.managerA.headers, { name: "C", city: "Pune" }))
        .statusCode,
    ).toBe(403);
  });

  it("can only invite people to their own branches", async () => {
    const s = await setup();
    const invite = (branchIds: string[]) =>
      req("POST", `${s.base}/invites`, s.managerA.headers, {
        channel: "sms",
        phone: randomPhone(),
        role: "trainer",
        branchIds,
      });
    expect((await invite([s.branchA.id])).statusCode).toBe(201);
    expect((await invite([s.branchB.id])).statusCode).toBe(403);
    expect((await invite([])).statusCode).toBe(403); // "every branch" is wider than their own
  });

  it("only see colleagues who share a branch with them, plus staff for every branch", async () => {
    const s = await setup();
    const names = (
      (await req("GET", `${s.base}/staff`, s.managerA.headers)).json() as { name: string }[]
    ).map((m) => m.name);
    expect(names.sort()).toEqual(["Manager A", "Owner"]);
  });
});
