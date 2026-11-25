import { createDb, withTenant, type DbHandle } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { invoices, memberships, outboxEvents } from "@gym/db/schema";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { runPaymentReminders } from "../src/billing/reminders";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, testEnv } from "./helpers";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let worker: WorkerHandle;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv()));
  dbh = createDb(testEnv().DATABASE_URL);
  worker = await createWorker(testEnv({ OUTBOX_POLL_MS: "50" }));
});
afterAll(async () => {
  await worker.close();
  await api.close();
  await dbh.pool.end();
});

const today = () => todayIn("Asia/Kolkata");

async function overdueInvoice(daysOverdue: number) {
  const g = await gymWithMember(api, dbh.db);
  const m = (await g.enrol((await g.plan({})).id)).json();
  let invoice: { id: string } = { id: "" };
  await vi.waitFor(
    async () => {
      [invoice] = (await g.call("GET", `${g.base}/members/${g.member.id}/invoices`)).json();
      expect(invoice?.id).toBeTruthy();
    },
    { timeout: 15_000, interval: 100 },
  );
  const orgId = g.base.split("/").at(-1) ?? "";
  const setDue = (days: number) =>
    withTenant(dbh.db, orgId, (tx) =>
      tx
        .update(invoices)
        .set({ dueDate: addDays(today(), -days) })
        .where(eq(invoices.id, invoice.id)),
    );
  await setDue(daysOverdue);
  const read = async () =>
    (
      await withTenant(dbh.db, orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, invoice.id)),
      )
    )[0];
  const membership = async () =>
    (
      await withTenant(dbh.db, orgId, (tx) =>
        tx.select().from(memberships).where(eq(memberships.id, m.id)),
      )
    )[0];
  return { g, invoice, setDue, read, membership };
}

const remindersFor = async (invoiceId: string) =>
  (
    await dbh.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "invoice.payment_reminder"))
      // Ids are UUIDv7, so this is the order they were raised in; without it Postgres may return any order.
      .orderBy(asc(outboxEvents.id))
  ).filter((e) => (e.payload as { invoiceId: string }).invoiceId === invoiceId);

describe("reminders for unpaid invoices", () => {
  it("reminds on the due day, then after 2 and 5 days, never twice for the same step", async () => {
    const t = await overdueInvoice(0);
    await runPaymentReminders(dbh.db, 7);
    await runPaymentReminders(dbh.db, 7);
    expect((await t.read())?.remindersSent).toBe(1);
    await t.setDue(2);
    await runPaymentReminders(dbh.db, 7);
    await t.setDue(5);
    await runPaymentReminders(dbh.db, 7);
    await runPaymentReminders(dbh.db, 7);
    const sent = await remindersFor(t.invoice.id);
    expect(sent.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect((await t.membership())?.status).toBe("active");
  });

  it("after the grace period the unpaid membership expires", async () => {
    const t = await overdueInvoice(7);
    await runPaymentReminders(dbh.db, 7);
    expect((await t.membership())?.status).toBe("expired");
  });

  it("paid invoices get no reminders", async () => {
    const t = await overdueInvoice(3);
    await api.inject({
      method: "POST",
      url: `${t.g.base}/invoices/${t.invoice.id}/payments`,
      headers: { ...t.g.owner.headers, "idempotency-key": `p-${Math.random()}` },
      payload: { method: "cash", amountPaise: 236_000 },
    });
    await runPaymentReminders(dbh.db, 7);
    expect(await remindersFor(t.invoice.id)).toHaveLength(0);
  });

  it("is scheduled hourly", async () => {
    const keys = (await worker.maintenanceQueue.getJobSchedulers()).map((s) => s.key);
    expect(keys).toContain("payment-reminders-hourly");
  });
});
