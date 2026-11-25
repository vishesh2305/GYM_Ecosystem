import { createDb, type DbHandle } from "@gym/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { gymWithMember, testEnv } from "./helpers";

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
type Lead = {
  id: string;
  stage: string;
  memberId: string | null;
  trialAt: string | null;
  phone: string | null;
};
type Task = {
  id: string;
  title: string;
  dueAt: string;
  doneAt: string | null;
  assignedTo: string | null;
};
const randomPhone = () => `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function newLead(g: Gym, extra: object = {}) {
  const res = await g.call("POST", `${g.base}/leads`, {
    name: "Rohan",
    phone: randomPhone(),
    branchId: g.branch.id,
    source: "walk_in",
    interest: "Weight loss, mornings",
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Lead;
}

describe("leads pipeline", () => {
  it("takes a walk-in from enquiry through a trial to joining as a member", async () => {
    const g = await gymWithMember(api, dbh.db);
    const lead = await newLead(g);
    expect(lead).toMatchObject({ stage: "new", phone: expect.stringMatching(/^\+9198/) });

    const contacted = await g.call("PATCH", `${g.base}/leads/${lead.id}`, { stage: "contacted" });
    expect(contacted.json().stage).toBe("contacted");

    const trialAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const trial = await g.call("POST", `${g.base}/leads/${lead.id}/trial`, { startsAt: trialAt });
    expect(trial.json()).toMatchObject({ stage: "trial_booked", trialAt });
    const detail = (await g.call("GET", `${g.base}/leads/${lead.id}`)).json() as Lead & {
      tasks: Task[];
    };
    expect(detail.tasks).toEqual([
      expect.objectContaining({
        title: "Follow up with Rohan after their trial",
        dueAt: new Date(Date.parse(trialAt) + 86_400_000).toISOString(),
        assignedTo: expect.any(String),
      }),
    ]);

    const joined = await g.call("POST", `${g.base}/leads/${lead.id}/convert`);
    expect(joined.statusCode).toBe(200);
    const won = joined.json() as Lead;
    expect(won.stage).toBe("won");
    const member = await g.call("GET", `${g.base}/members/${won.memberId}`);
    expect(member.json()).toMatchObject({ name: "Rohan", phone: lead.phone });

    // Converting again changes nothing; a member's lead can no longer be edited.
    expect((await g.call("POST", `${g.base}/leads/${lead.id}/convert`)).json().memberId).toBe(
      won.memberId,
    );
    expect((await g.call("PATCH", `${g.base}/leads/${lead.id}`, { stage: "new" })).statusCode).toBe(
      409,
    );
  });

  it("links a lead who is already a member instead of creating a second member", async () => {
    const g = await gymWithMember(api, dbh.db);
    const phone = `+91${randomPhone()}`;
    const existing = (
      await g.call("POST", `${g.base}/members`, {
        name: "Rohan K",
        phone,
        homeBranchId: g.branch.id,
      })
    ).json() as { id: string };
    const lead = await newLead(g, { phone });
    const won = (await g.call("POST", `${g.base}/leads/${lead.id}/convert`)).json() as Lead;
    expect(won.memberId).toBe(existing.id);
  });

  it("keeps one open lead per phone number and needs a reason to lose one", async () => {
    const g = await gymWithMember(api, dbh.db);
    const phone = randomPhone();
    const lead = await newLead(g, { phone });
    const twice = await g.call("POST", `${g.base}/leads`, {
      name: "Rohan again",
      phone,
      branchId: g.branch.id,
      source: "phone",
    });
    expect(twice.statusCode).toBe(409);

    expect(
      (await g.call("PATCH", `${g.base}/leads/${lead.id}`, { stage: "lost" })).statusCode,
    ).toBe(400);
    const lost = await g.call("PATCH", `${g.base}/leads/${lead.id}`, {
      stage: "lost",
      lostReason: "Too far from home",
    });
    expect(lost.json()).toMatchObject({ stage: "lost", lostReason: "Too far from home" });
    // Once lost, the same person can come back as a new lead...
    await newLead(g, { phone });
    // ...and reopening the old one would make two open leads for one phone, so it is refused.
    const reopened = await g.call("PATCH", `${g.base}/leads/${lead.id}`, { stage: "contacted" });
    expect(reopened.statusCode).toBe(409);
  });

  it("refuses leads without a way to reach them and joining by editing the stage", async () => {
    const g = await gymWithMember(api, dbh.db);
    const noContact = await g.call("POST", `${g.base}/leads`, {
      name: "Ghost",
      branchId: g.branch.id,
      source: "other",
    });
    expect(noContact.statusCode).toBe(400);
    const lead = await newLead(g, { phone: undefined, email: "Asha@Example.com" });
    expect(lead.phone).toBeNull();
    expect((await g.call("PATCH", `${g.base}/leads/${lead.id}`, { stage: "won" })).statusCode).toBe(
      400,
    );
    expect(
      (await g.call("PATCH", `${g.base}/leads/${lead.id}`, { assignedTo: crypto.randomUUID() }))
        .statusCode,
    ).toBe(400);
  });

  it("lists and searches leads by stage and name", async () => {
    const g = await gymWithMember(api, dbh.db);
    const a = await newLead(g, { name: "Meera Shah" });
    await newLead(g, { name: "Kabir Rao" });
    await g.call("PATCH", `${g.base}/leads/${a.id}`, { stage: "contacted" });
    const contacted = (await g.call("GET", `${g.base}/leads?stage=contacted`)).json() as Lead[];
    expect(contacted.map((l) => l.id)).toEqual([a.id]);
    const found = (await g.call("GET", `${g.base}/leads?q=kabir`)).json() as { name: string }[];
    expect(found.map((l) => l.name)).toEqual(["Kabir Rao"]);
  });
});

describe("follow-up tasks", () => {
  it("show each staff member their open follow-ups, soonest first, until done", async () => {
    const g = await gymWithMember(api, dbh.db);
    const desk = await g.staff("front_desk");
    const lead = await newLead(g, { name: "Tara" });
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const add = (body: object) => g.call("POST", `${g.base}/leads/${lead.id}/tasks`, body);
    const second = (await add({ title: "Send price list", dueAt: later })).json() as Task;
    const first = (
      await add({ title: "Call back", dueAt: soon, assignedTo: desk.staffId })
    ).json() as Task;

    const all = (await g.call("GET", `${g.base}/tasks`)).json() as (Task & { leadName: string })[];
    expect(all.map((t) => [t.title, t.leadName])).toEqual([
      ["Call back", "Tara"],
      ["Send price list", "Tara"],
    ]);
    const mine = await api.inject({
      method: "GET",
      url: `${g.base}/tasks?mine=true`,
      headers: desk.headers,
    });
    expect((mine.json() as Task[]).map((t) => t.id)).toEqual([first.id]);

    const done = await g.call("POST", `${g.base}/tasks/${first.id}/complete`);
    expect(done.json().doneAt).not.toBeNull();
    expect(((await g.call("GET", `${g.base}/tasks`)).json() as Task[]).map((t) => t.id)).toEqual([
      second.id,
    ]);
  });

  it("are hidden from staff of other branches, like the leads themselves", async () => {
    const g = await gymWithMember(api, dbh.db);
    const other = (
      await g.call("POST", `${g.base}/branches`, { name: "Baner", city: "Pune" })
    ).json() as { id: string };
    const lead = await newLead(g);
    await g.call("POST", `${g.base}/leads/${lead.id}/tasks`, {
      title: "Call back",
      dueAt: new Date().toISOString(),
    });
    const elsewhere = await g.staff("front_desk", [other.id]);
    const get = (url: string) => api.inject({ method: "GET", url, headers: elsewhere.headers });
    expect((await get(`${g.base}/leads/${lead.id}`)).statusCode).toBe(404);
    expect((await get(`${g.base}/leads`)).json()).toEqual([]);
    expect((await get(`${g.base}/tasks`)).json()).toEqual([]);
    const trainer = await g.staff("trainer");
    expect(
      (await api.inject({ method: "GET", url: `${g.base}/leads`, headers: trainer.headers }))
        .statusCode,
    ).toBe(403);
  });
});
