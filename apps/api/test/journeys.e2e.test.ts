import { createDb, withTenant, type DbHandle } from "@gym/db";
import { and, eq } from "@gym/db/orm";
import {
  autopayMandates,
  bookings,
  checkIns,
  classSessions,
  memberships,
  notifications,
} from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { ConsoleChannel } from "../src/notifications/channels";
import { runNotificationDelivery } from "../src/notifications/delivery";
import {
  notifyClassCancelled,
  notifyPaymentDue,
  notifyPaymentFailed,
  notifyWaitlistPromoted,
  runJourneys,
} from "../src/notifications/journeys";
import type { EventEnvelope } from "../src/platform/events";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let worker: WorkerHandle;
const whatsapp = new ConsoleChannel("whatsapp");

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  worker = await createWorker(testEnv({ OUTBOX_POLL_MS: "50" }), { channels: [whatsapp] });
});
afterAll(async () => {
  await worker.close();
  await api.close();
  await dbh.pool.end();
});

const IST = "Asia/Kolkata";
type Gym = Awaited<ReturnType<typeof gymWithMember>>;
const orgOf = (g: Gym) => g.base.split("/").pop() ?? "";
const randomPhone = () => `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

/** A gym with `count` members on running memberships (each with a phone number). */
async function gymWithMembers(count: number) {
  const g = await gymWithMember(api, dbh.db);
  const ids = await g.membersWithMembership(count);
  for (const id of ids) await g.call("PATCH", `${g.base}/members/${id}`, { phone: randomPhone() });
  return { g, ids, orgId: orgOf(g) };
}

const inGym = <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(dbh.db, orgId, fn);

async function messages(orgId: string, memberId: string, key?: string) {
  const rows = await inGym(orgId, (tx) =>
    tx.select().from(notifications).where(eq(notifications.memberId, memberId)),
  );
  return key ? rows.filter((r) => r.key === key) : rows;
}

describe("renewal reminders", () => {
  it("go out 7, 3 and 1 days before a membership ends, once each", async () => {
    const now = new Date();
    const today = todayIn(IST, now);
    const { ids, orgId } = await gymWithMembers(4);
    const [due, renewed, autopay, later] = ids as [string, string, string, string];
    await inGym(orgId, async (tx) => {
      await tx
        .update(memberships)
        .set({ startDate: addDays(today, -23), endDate: addDays(today, 7) })
        .where(eq(memberships.tenantId, orgId));
      await tx
        .update(memberships)
        .set({ endDate: addDays(today, 20) })
        .where(eq(memberships.memberId, later));
      // Already renewed: the next membership is waiting to start.
      const [current] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.memberId, renewed));
      if (!current) throw new Error("no membership");
      const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = current;
      await tx.insert(memberships).values({
        ...copy,
        status: "pending",
        startDate: addDays(today, 8),
        endDate: addDays(today, 37),
      });
      await tx.insert(autopayMandates).values({
        tenantId: orgId,
        memberId: autopay,
        status: "active",
        maxAmountPaise: 500_000,
        gateway: "fake",
        gatewayCustomerId: "cust_test",
        gatewayOrderId: "order_test",
      });
    });

    await runJourneys(dbh.db, now);
    await runJourneys(dbh.db, now);
    expect(await messages(orgId, due, "renewal_due")).toEqual([
      expect.objectContaining({
        key: "renewal_due",
        vars: expect.objectContaining({ endDate: addDays(today, 7), plan: "Free month" }),
      }),
    ]);
    for (const id of [renewed, autopay, later])
      expect(await messages(orgId, id, "renewal_due")).toEqual([]);

    await runJourneys(dbh.db, new Date(now.getTime() + 4 * 86_400_000));
    await runJourneys(dbh.db, new Date(now.getTime() + 6 * 86_400_000));
    expect((await messages(orgId, due, "renewal_due")).map((n) => n.dedupeKey).sort()).toEqual([
      expect.stringMatching(/:1$/),
      expect.stringMatching(/:3$/),
      expect.stringMatching(/:7$/),
    ]);
  });
});

describe("class reminders", () => {
  it("go to members with a place, two hours before, and expire when the class starts", async () => {
    const { g, ids, orgId } = await gymWithMembers(3);
    const [booked, waiting, later] = ids as [string, string, string];
    const now = new Date();
    const session = async (startsInHours: number) => {
      const startsAt = new Date(now.getTime() + startsInHours * 3_600_000);
      const [row] = await inGym(orgId, (tx) =>
        tx
          .insert(classSessions)
          .values({
            tenantId: orgId,
            branchId: g.branch.id,
            kind: "class",
            name: "Yoga",
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3_600_000),
            capacity: 10,
            cancelWindowMinutes: 60,
          })
          .returning(),
      );
      if (!row) throw new Error("no session");
      return row;
    };
    const soon = await session(1.5);
    const tomorrow = await session(26);
    await inGym(orgId, (tx) =>
      tx.insert(bookings).values([
        { tenantId: orgId, sessionId: soon.id, memberId: booked, status: "confirmed" },
        { tenantId: orgId, sessionId: soon.id, memberId: waiting, status: "waitlisted" },
        { tenantId: orgId, sessionId: tomorrow.id, memberId: later, status: "confirmed" },
      ]),
    );

    await runJourneys(dbh.db, now);
    await runJourneys(dbh.db, new Date(now.getTime() + 60_000));
    expect(await messages(orgId, booked, "class_reminder")).toEqual([
      expect.objectContaining({ key: "class_reminder", expiresAt: soon.startsAt }),
    ]);
    expect(await messages(orgId, waiting, "class_reminder")).toEqual([]);
    expect(await messages(orgId, later, "class_reminder")).toEqual([]);
  });
});

describe("we miss you", () => {
  it("goes once per absence to members who have not come in for a week", async () => {
    const now = new Date();
    const today = todayIn(IST, now);
    const { g, ids, orgId } = await gymWithMembers(3);
    const [neverCame, regular, lapsed] = ids as [string, string, string];
    const visit = (memberId: string, daysAgo: number) =>
      inGym(orgId, (tx) =>
        tx.insert(checkIns).values({
          tenantId: orgId,
          branchId: g.branch.id,
          memberId,
          method: "desk",
          checkedInAt: new Date(now.getTime() - daysAgo * 86_400_000),
          checkedOutAt: new Date(now.getTime() - daysAgo * 86_400_000 + 3_600_000),
        }),
      );
    await inGym(orgId, (tx) =>
      tx
        .update(memberships)
        .set({ startDate: addDays(today, -20) })
        .where(eq(memberships.tenantId, orgId)),
    );
    await visit(regular, 2);
    await visit(lapsed, 9);

    await runJourneys(dbh.db, now);
    await runJourneys(dbh.db, now);
    expect((await messages(orgId, neverCame)).map((n) => n.key)).toEqual(["inactive"]);
    expect((await messages(orgId, lapsed)).map((n) => n.key)).toEqual(["inactive"]);
    expect(await messages(orgId, regular)).toEqual([]);

    // They came back, then stayed away again: a new absence, a new nudge.
    await visit(lapsed, 8);
    await runJourneys(dbh.db, now);
    expect(await messages(orgId, lapsed)).toHaveLength(2);
  });
});

describe("event-driven messages", () => {
  const envelope = (tenantId: string, type: string): EventEnvelope => ({
    id: crypto.randomUUID(),
    type,
    tenantId,
    payload: {},
    occurredAt: new Date().toISOString(),
  });

  it("each fire once per trigger, even when the same event arrives twice", async () => {
    const { ids, orgId } = await gymWithMembers(1);
    const [memberId] = ids as [string];
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const paymentId = crypto.randomUUID();
    for (let i = 0; i < 2; i++)
      await inGym(orgId, async (tx) => {
        await notifyWaitlistPromoted.handle(
          { bookingId: paymentId, sessionId: paymentId, memberId, name: "Spin", startsAt },
          { tx, event: envelope(orgId, "booking.promoted") },
        );
        await notifyPaymentDue.handle(
          { invoiceId: paymentId, memberId, attempt: 1, duePaise: 99_900, dueDate: "2026-12-05" },
          { tx, event: envelope(orgId, "invoice.payment_reminder") },
        );
        await notifyPaymentFailed.handle(
          { paymentId, memberId, amountPaise: 99_900, method: "autopay" },
          { tx, event: envelope(orgId, "payment.failed") },
        );
      });
    const rows = await messages(orgId, memberId);
    expect(rows.map((r) => r.key).sort()).toEqual([
      "payment_due",
      "payment_failed",
      "waitlist_promoted",
    ]);
    expect(rows.find((r) => r.key === "payment_due")?.vars).toMatchObject({
      amountPaise: 99_900,
      gym: "Test Gym",
    });
    expect(rows.find((r) => r.key === "waitlist_promoted")?.expiresAt?.toISOString()).toBe(
      startsAt,
    );
  });

  it("tell everyone booked when a class is cancelled, end to end through the worker", async () => {
    const { g, ids, orgId } = await gymWithMembers(2);
    const startsAt = new Date(Date.now() + 5 * 3_600_000);
    const [session] = await inGym(orgId, (tx) =>
      tx
        .insert(classSessions)
        .values({
          tenantId: orgId,
          branchId: g.branch.id,
          kind: "class",
          name: "HIIT",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          capacity: 10,
          cancelWindowMinutes: 60,
        })
        .returning(),
    );
    if (!session) throw new Error("no session");
    await inGym(orgId, (tx) =>
      tx.insert(bookings).values(
        ids.map((memberId) => ({
          tenantId: orgId,
          sessionId: session.id,
          memberId,
          status: "confirmed" as const,
        })),
      ),
    );
    const res = await g.call("POST", `${g.base}/sessions/${session.id}/cancel`, {
      reason: "Coach unwell",
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(
      async () => {
        const rows = await inGym(orgId, (tx) =>
          tx
            .select()
            .from(notifications)
            .where(
              and(eq(notifications.tenantId, orgId), eq(notifications.key, "class_cancelled")),
            ),
        );
        expect(rows).toHaveLength(2);
      },
      { timeout: 10_000, interval: 100 },
    );
    // Urgent, so it goes out at once whatever the time (quiet hours do not apply).
    await runNotificationDelivery(dbh.db, [whatsapp], {
      perGym: 100,
      maxAttempts: 3,
      retryMs: 60_000,
    });
    const cancelled = whatsapp.sent.filter((m) => m.key === "class_cancelled");
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0]?.body).toContain("Coach unwell");
  });
});

it("registers every event-driven journey with the worker", async () => {
  const { handlers } = await import("../src/worker/handlers");
  for (const h of [
    notifyWaitlistPromoted,
    notifyClassCancelled,
    notifyPaymentDue,
    notifyPaymentFailed,
  ])
    expect(handlers).toContain(h);
});
