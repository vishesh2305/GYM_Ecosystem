import { createDb, withTenant, type DbHandle } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { classes, classSessions, outboxEvents } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { generateSessions, runSessionGeneration } from "../src/scheduling/timetable";
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

const DAILY = [0, 1, 2, 3, 4, 5, 6];

/** A gym with a daily class at `startTime` (India time). */
async function gymWithClass(body: object = {}) {
  const g = await gymWithMember(api, dbh.db);
  const orgId = g.base.split("/").at(-1) ?? "";
  const res = await g.call("POST", `${g.base}/branches/${g.branch.id}/classes`, {
    name: "Morning yoga",
    capacity: 20,
    durationMinutes: 60,
    weekdays: DAILY,
    startTime: "07:00",
    ...body,
  });
  const sessions = () =>
    withTenant(dbh.db, orgId, (tx) =>
      tx
        .select()
        .from(classSessions)
        .where(eq(classSessions.classId, res.json().id))
        .orderBy(asc(classSessions.startsAt)),
    );
  return { g, orgId, res, cls: res.json(), sessions };
}

describe("class timetable", () => {
  it("adds a weekly class and creates its sessions for the next two weeks, in the gym's time", async () => {
    const t = await gymWithClass();
    expect(t.res.statusCode).toBe(201);
    expect(t.cls).toMatchObject({
      name: "Morning yoga",
      capacity: 20,
      weekdays: DAILY,
      cancelWindowMinutes: 120,
      active: true,
    });
    const sessions = await t.sessions();
    expect(sessions.length).toBeGreaterThanOrEqual(13);
    expect(sessions.length).toBeLessThanOrEqual(14);
    for (const s of sessions) {
      expect(s.startsAt.toISOString().slice(11)).toBe("01:30:00.000Z"); // 07:00 in India
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(3_600_000);
      expect(s.startsAt.getTime()).toBeGreaterThan(Date.now());
    }
    const before = sessions.length;
    await runSessionGeneration(dbh.db);
    expect(await t.sessions()).toHaveLength(before);
  });

  it("keeps two weeks ahead as days pass, and only on the class's weekdays and dates", async () => {
    const t = await gymWithClass({
      weekdays: [1, 3],
      startsOn: "2099-01-01",
      endsOn: "2099-01-31",
    });
    expect(await t.sessions()).toHaveLength(0);
    const [row] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(classes).where(eq(classes.id, t.cls.id)),
    );
    if (!row) throw new Error("class");
    // 2099-01-26 is a Monday: Mon 26 and Wed 28 are left before the class ends on the 31st.
    const created = await withTenant(dbh.db, t.orgId, (tx) =>
      generateSessions(tx, row, "Asia/Kolkata", new Date("2099-01-25T12:00:00Z")),
    );
    expect(created).toBe(2);
    expect((await t.sessions()).map((s) => s.startsAt.toISOString())).toEqual([
      "2099-01-26T01:30:00.000Z",
      "2099-01-28T01:30:00.000Z",
    ]);
  });

  it("checks the dates, the instructor and who may change the timetable", async () => {
    const t = await gymWithClass();
    const url = `${t.g.base}/branches/${t.g.branch.id}/classes`;
    const body = {
      name: "Spin",
      capacity: 10,
      durationMinutes: 45,
      weekdays: [1],
      startTime: "18:00",
    };
    expect(
      (await t.g.call("POST", url, { ...body, startsOn: "2099-02-01", endsOn: "2099-01-01" }))
        .statusCode,
    ).toBe(400);
    expect((await t.g.call("POST", url, { ...body, startTime: "6pm" })).statusCode).toBe(400);
    expect((await t.g.call("POST", url, { ...body, instructorId: t.g.member.id })).statusCode).toBe(
      400,
    );
    const [owner] = (await t.g.call("GET", `${t.g.base}/staff`)).json();
    expect((await t.g.call("POST", url, { ...body, instructorId: owner.id })).json()).toMatchObject(
      {
        instructorId: owner.id,
      },
    );

    const desk = await t.g.staff("front_desk");
    expect(
      (await api.inject({ method: "POST", url, headers: desk.headers, payload: body })).statusCode,
    ).toBe(403);
    const other = (
      await t.g.call("POST", `${t.g.base}/branches`, { name: "Second", city: "Pune" })
    ).json();
    const sideManager = await t.g.staff("manager", [other.id]);
    expect(
      (await api.inject({ method: "POST", url, headers: sideManager.headers, payload: body }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api.inject({
          method: "GET",
          url: `${t.g.base}/classes`,
          headers: sideManager.headers,
        })
      ).json(),
    ).toEqual([]);
  });

  it("changes upcoming sessions along with the class", async () => {
    const t = await gymWithClass();
    const res = await t.g.call("PATCH", `${t.g.base}/classes/${t.cls.id}`, {
      capacity: 25,
      room: "Studio 2",
      description: "Bring a mat",
    });
    expect(res.json()).toMatchObject({
      capacity: 25,
      room: "Studio 2",
      description: "Bring a mat",
    });
    for (const s of await t.sessions()) expect(s).toMatchObject({ capacity: 25, room: "Studio 2" });
    expect(
      (await t.g.call("PATCH", `${t.g.base}/classes/${t.cls.id}`, { instructorId: t.g.member.id }))
        .statusCode,
    ).toBe(400);
  });

  it("taking a class off the timetable cancels its upcoming sessions and tells members", async () => {
    const t = await gymWithClass();
    const archived = await t.g.call("POST", `${t.g.base}/classes/${t.cls.id}/archive`);
    expect(archived.json().active).toBe(false);
    expect((await t.sessions()).every((s) => s.status === "cancelled")).toBe(true);
    expect((await t.g.call("GET", `${t.g.base}/classes`)).json()).toEqual([]);
    expect((await t.g.call("GET", `${t.g.base}/classes?includeArchived=true`)).json()).toHaveLength(
      1,
    );
    const events = await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, t.orgId));
    expect(events.filter((e) => e.type === "class_session.cancelled").length).toBe(
      (await t.sessions()).length,
    );
    await runSessionGeneration(dbh.db);
    expect((await t.sessions()).every((s) => s.status === "cancelled")).toBe(true);
  });

  it("lists sessions in a date range for staff, and lets managers cancel one", async () => {
    const t = await gymWithClass();
    const list = (await t.g.call("GET", `${t.g.base}/sessions`)).json();
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(list[0]).toMatchObject({ name: "Morning yoga", booked: 0, waitlisted: 0 });
    const day = 86_400_000;
    const range = (from: number, to: number) =>
      `${t.g.base}/sessions?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
    expect((await t.g.call("GET", range(Date.now(), Date.now() - day))).statusCode).toBe(400);
    expect((await t.g.call("GET", range(Date.now(), Date.now() + 40 * day))).statusCode).toBe(400);
    expect(
      (await t.g.call("GET", `${t.g.base}/sessions?branchId=${t.g.branch.id}`)).json(),
    ).toHaveLength(list.length);

    const session = list[0];
    const trainer = await t.g.staff("trainer");
    const cancelUrl = `${t.g.base}/sessions/${session.id}/cancel`;
    expect(
      (
        await api.inject({
          method: "POST",
          url: cancelUrl,
          headers: trainer.headers,
          payload: { reason: "x" },
        })
      ).statusCode,
    ).toBe(403);
    const cancelled = await t.g.call("POST", cancelUrl, { reason: "Instructor unwell" });
    expect(cancelled.json()).toMatchObject({
      status: "cancelled",
      cancelReason: "Instructor unwell",
    });
    expect((await t.g.call("POST", cancelUrl, { reason: "again" })).json().cancelReason).toBe(
      "Instructor unwell",
    );
  });
});
