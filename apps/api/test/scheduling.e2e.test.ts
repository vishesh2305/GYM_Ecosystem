import { createDb, withTenant, type DbHandle } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { bookings, classes, classSessions, outboxEvents } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { generateSessions, runSessionGeneration } from "../src/scheduling/timetable";
import { gymWithMember, signedInUser, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

beforeAll(async () => {
  // The parallel booking test sends 200 requests as one owner.
  ({ app: api } = await createApp(testEnv({ RATE_LIMIT_MAX: "2000" })));
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

/** A daily class with `capacity` places, `count` members with running memberships, and its next session. */
async function sessionWithMembers(count: number, capacity: number, body: object = {}) {
  const t = await gymWithClass({ capacity, ...body });
  const memberIds = await t.g.membersWithMembership(count);
  const [session] = await t.sessions();
  if (!session) throw new Error("no session");
  const bookingsUrl = `${t.g.base}/sessions/${session.id}/bookings`;
  const book = (memberId: string, headers = t.g.owner.headers) =>
    api.inject({ method: "POST", url: bookingsUrl, headers, payload: { memberId } });
  const roster = async () => (await t.g.call("GET", bookingsUrl)).json();
  return { ...t, memberIds, session, bookingsUrl, book, roster };
}

const eventsOf = async (orgId: string, type: string) =>
  (
    await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, orgId))
      .orderBy(asc(outboxEvents.id))
  )
    .filter((e) => e.type === type)
    .map((e) => e.payload as Record<string, unknown>);

describe("booking classes", () => {
  it("200 members booking 20 places at once: exactly 20 get a place, the rest wait in order", async () => {
    const t = await sessionWithMembers(200, 20);
    const results = await Promise.all(t.memberIds.map((id) => t.book(id).then((r) => r.json())));
    const confirmed = results.filter((r) => r.status === "confirmed");
    const waiting = results.filter((r) => r.status === "waitlisted");
    expect(confirmed).toHaveLength(20);
    expect(waiting).toHaveLength(180);
    expect(waiting.map((w) => w.waitlistPosition).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 180 }, (_, i) => i + 1),
    );
    const listed = (await t.g.call("GET", `${t.g.base}/sessions`)).json();
    expect(listed.find((s: { id: string }) => s.id === t.session.id)).toMatchObject({
      booked: 20,
      waitlisted: 180,
    });
    const roster = await t.roster();
    expect(roster.filter((b: { status: string }) => b.status === "waitlisted")[0]).toMatchObject({
      waitlistPosition: 1,
      memberName: expect.stringMatching(/^Member /),
    });
  });

  it("booking twice keeps one booking; cancelling early gives the place to the first in line", async () => {
    const t = await sessionWithMembers(3, 1, { cancelWindowMinutes: 0 });
    const [a, b, c] = t.memberIds;
    const first = (await t.book(a ?? "")).json();
    expect((await t.book(a ?? "")).json().id).toBe(first.id);
    const second = (await t.book(b ?? "")).json();
    const third = (await t.book(c ?? "")).json();
    expect([second.waitlistPosition, third.waitlistPosition]).toEqual([1, 2]);

    const cancelled = await t.g.call("POST", `${t.g.base}/bookings/${first.id}/cancel`);
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
    const roster = await t.roster();
    expect(roster.find((r: { id: string }) => r.id === second.id)).toMatchObject({
      status: "confirmed",
      waitlistPosition: null,
    });
    expect(roster.find((r: { id: string }) => r.id === third.id).waitlistPosition).toBe(1);
    expect(await eventsOf(t.orgId, "booking.promoted")).toEqual([
      expect.objectContaining({ bookingId: second.id, memberId: b }),
    ]);
    // Cancelling again changes nothing; a waiting member's cancellation is never late.
    expect((await t.g.call("POST", `${t.g.base}/bookings/${first.id}/cancel`)).json().status).toBe(
      "cancelled",
    );
    expect((await t.g.call("POST", `${t.g.base}/bookings/${third.id}/cancel`)).json().status).toBe(
      "cancelled",
    );
  });

  it("cancelling inside the cancellation window counts as late", async () => {
    const t = await sessionWithMembers(1, 5, { cancelWindowMinutes: 2880 });
    const booked = (await t.book(t.memberIds[0] ?? "")).json();
    expect((await t.g.call("POST", `${t.g.base}/bookings/${booked.id}/cancel`)).json().status).toBe(
      "late_cancelled",
    );
  });

  it("refuses members without a membership, other gyms' members, and sessions that are off or started", async () => {
    const t = await sessionWithMembers(1, 5);
    expect((await t.book(t.g.member.id)).statusCode).toBe(400); // the helper's member never enrolled
    const elsewhere = await gymWithMember(api, dbh.db);
    expect((await t.book(elsewhere.member.id)).statusCode).toBe(404);

    const [, later] = await t.sessions();
    await t.g.call("POST", `${t.g.base}/sessions/${later?.id}/cancel`, { reason: "Holiday" });
    expect(
      (
        await t.g.call("POST", `${t.g.base}/sessions/${later?.id}/bookings`, {
          memberId: t.memberIds[0],
        })
      ).statusCode,
    ).toBe(400);
    await withTenant(dbh.db, t.orgId, (tx) =>
      tx
        .update(classSessions)
        .set({ startsAt: new Date(Date.now() - 60_000) })
        .where(eq(classSessions.id, t.session.id)),
    );
    expect((await t.book(t.memberIds[0] ?? "")).statusCode).toBe(400);
  });

  it("front desk books members; trainers can see who is booked but not book", async () => {
    const t = await sessionWithMembers(1, 5);
    const desk = await t.g.staff("front_desk");
    expect((await t.book(t.memberIds[0] ?? "", desk.headers)).statusCode).toBe(201);
    const trainer = await t.g.staff("trainer");
    expect((await t.book(t.memberIds[0] ?? "", trainer.headers)).statusCode).toBe(403);
    expect(
      (await api.inject({ method: "GET", url: t.bookingsUrl, headers: trainer.headers })).json(),
    ).toHaveLength(1);
  });

  it("more places promote waiting members; a cancelled session frees everyone and tells them", async () => {
    const t = await sessionWithMembers(3, 1);
    for (const id of t.memberIds) await t.book(id);
    await t.g.call("PATCH", `${t.g.base}/classes/${t.cls.id}`, { capacity: 2 });
    const statuses = (await t.roster()).map((r: { status: string }) => r.status);
    expect(statuses).toEqual(["confirmed", "confirmed", "waitlisted"]);

    await t.g.call("POST", `${t.g.base}/sessions/${t.session.id}/cancel`, { reason: "Power cut" });
    expect((await t.roster()).every((r: { status: string }) => r.status === "cancelled")).toBe(
      true,
    );
    const [cancelledEvent] = (await eventsOf(t.orgId, "class_session.cancelled")).filter(
      (e) => e.sessionId === t.session.id,
    );
    expect((cancelledEvent?.memberIds as string[]).sort()).toEqual([...t.memberIds].sort());
  });

  it("members see sessions with places left, book themselves, and cancel in the app", async () => {
    const t = await gymWithClass({ capacity: 1 });
    const phone = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const member = (
      await t.g.call("POST", `${t.g.base}/members`, {
        name: "Asha",
        phone,
        homeBranchId: t.g.branch.id,
      })
    ).json();
    const plan = await t.g.plan({ pricePaise: 0, joiningFeePaise: 0 });
    await t.g.call("POST", `${t.g.base}/members/${member.id}/memberships`, { planId: plan.id });
    const me = await signedInUser(api, dbh.db, { phone });
    const mine = `/v1/me/gyms/${t.orgId}`;
    const asMe = (method: string, url: string) =>
      api.inject({ method, url: `${mine}${url}`, headers: me.headers });

    const [first] = (await asMe("GET", "/sessions")).json();
    expect(first).toMatchObject({ booked: 0, capacity: 1, myBooking: null });
    const booked = await asMe("POST", `/sessions/${first.id}/bookings`);
    expect(booked.statusCode).toBe(201);
    expect((await asMe("GET", "/sessions")).json()[0]).toMatchObject({
      booked: 1,
      myBooking: { id: booked.json().id, status: "confirmed" },
    });
    const [listed] = (await asMe("GET", "/bookings")).json();
    expect(listed).toMatchObject({ id: booked.json().id, session: { id: first.id } });
    expect((await asMe("POST", `/bookings/${booked.json().id}/cancel`)).json().status).toMatch(
      /cancelled/,
    );
    const stranger = await signedInUser(api, dbh.db, { phone: "+919700000000" });
    expect(
      (
        await api.inject({
          method: "GET",
          url: `${mine}/sessions`,
          headers: stranger.headers,
        })
      ).statusCode,
    ).toBe(404);
    const otherBooking = await t.g.membersWithMembership(1);
    const theirs = (
      await t.g.call("POST", `${t.g.base}/sessions/${first.id}/bookings`, {
        memberId: otherBooking[0],
      })
    ).json();
    expect((await asMe("POST", `/bookings/${theirs.id}/cancel`)).statusCode).toBe(404);
    const rows = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(bookings).where(eq(bookings.sessionId, first.id)),
    );
    expect(rows).toHaveLength(2);
  });
});
