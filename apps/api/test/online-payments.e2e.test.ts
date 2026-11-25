import { createDb, withTenant, type DbHandle } from "@gym/db";
import { and, eq } from "@gym/db/orm";
import { ledgerEntries, payments } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, razorpayWebhook, testEnv } from "./helpers";

const WEBHOOK_SECRET = "test-webhook-secret";
let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;
let worker: WorkerHandle;

beforeAll(async () => {
  ({ app: api } = await createApp(testEnv({ RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET })));
  dbh = createDb(testEnv().DATABASE_URL);
  worker = await createWorker(testEnv({ OUTBOX_POLL_MS: "50" }));
});
afterAll(async () => {
  await worker.close();
  await api.close();
  await dbh.pool.end();
});

async function invoiceReadyToPayOnline() {
  const g = await gymWithMember(api, dbh.db);
  await g.enrol((await g.plan({})).id);
  let invoice: { id: string } = { id: "" };
  await vi.waitFor(
    async () => {
      [invoice] = (await g.call("GET", `${g.base}/members/${g.member.id}/invoices`)).json();
      expect(invoice?.id).toBeTruthy();
    },
    { timeout: 15_000, interval: 100 },
  );
  const order = (await g.call("POST", `${g.base}/invoices/${invoice.id}/pay-online`)).json();
  return { g, invoice, order, orgId: g.base.split("/").at(-1) ?? "" };
}

const webhook = (
  event: string,
  order: { orderId: string; amountPaise: number; notes: Record<string, string> },
  paymentId?: string,
  secret = WEBHOOK_SECRET,
) => razorpayWebhook(api, event, order, { ...(paymentId && { paymentId }), secret });

describe("paying an invoice online", () => {
  it("creates a gateway order for exactly what is due", async () => {
    const { order } = await invoiceReadyToPayOnline();
    expect(order).toMatchObject({ gateway: "fake", amountPaise: 236_000, currency: "INR" });
    expect(order.orderId).toMatch(/^order_/);
  });

  it("a signed 'payment captured' webhook marks the invoice paid, once, and books it as awaiting settlement", async () => {
    const t = await invoiceReadyToPayOnline();
    const payId = "pay_once_123";
    expect((await webhook("payment.captured", t.order, payId)).statusCode).toBe(200);
    expect((await webhook("payment.captured", t.order, payId)).statusCode).toBe(200); // Razorpay retries
    const inv = (await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}`)).json();
    expect(inv).toMatchObject({ status: "paid", paidPaise: 236_000 });
    const clearing = await withTenant(dbh.db, t.orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.account, "gateway_clearing"))),
    );
    expect(clearing.map((l) => l.debitPaise)).toEqual([236_000]);
  });

  it("ignores webhooks with a wrong signature", async () => {
    const t = await invoiceReadyToPayOnline();
    expect(
      (await webhook("payment.captured", t.order, "pay_forged", "not-the-secret")).statusCode,
    ).toBe(400);
    expect((await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}`)).json().status).toBe(
      "issued",
    );
  });

  it("records failures, and a late 'failed' never undoes a captured payment", async () => {
    const t = await invoiceReadyToPayOnline();
    await webhook("payment.failed", t.order, "pay_fail_1");
    const [failed] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.gatewayOrderId, t.order.orderId)),
    );
    expect(failed?.status).toBe("failed");

    const retry = (
      await t.g.call("POST", `${t.g.base}/invoices/${t.invoice.id}/pay-online`)
    ).json();
    await webhook("payment.captured", retry, "pay_ok_2");
    await webhook("payment.failed", retry, "pay_ok_2");
    expect((await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}`)).json().status).toBe(
      "paid",
    );
  });

  it("ignores a capture for a different amount than ordered", async () => {
    const t = await invoiceReadyToPayOnline();
    await webhook("payment.captured", { ...t.order, amountPaise: 1 });
    const [p] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.gatewayOrderId, t.order.orderId)),
    );
    expect(p?.status).toBe("pending");
  });

  it("if the member also paid at the desk, the online money is kept on record for a refund, not applied twice", async () => {
    const t = await invoiceReadyToPayOnline();
    await api.inject({
      method: "POST",
      url: `${t.g.base}/invoices/${t.invoice.id}/payments`,
      headers: { ...t.g.owner.headers, "idempotency-key": "desk-full" },
      payload: { method: "cash", amountPaise: 236_000 },
    });
    expect((await webhook("payment.captured", t.order, "pay_double")).statusCode).toBe(200);
    const inv = (await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}`)).json();
    expect(inv.paidPaise).toBe(236_000);
    const { auditLog } = await import("@gym/db/schema");
    const [p] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.gatewayOrderId, t.order.orderId)),
    );
    expect(p?.status).toBe("captured");
    const audit = await dbh.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, p?.id ?? ""));
    expect(audit.map((a) => a.action)).toContain("payment.unapplied");
  });

  it("acknowledges events it does not need and orders it does not know", async () => {
    const t = await invoiceReadyToPayOnline();
    expect((await webhook("order.paid", t.order)).statusCode).toBe(200);
    expect(
      (await webhook("payment.captured", { ...t.order, orderId: "order_unknown" })).statusCode,
    ).toBe(200);
  });

  it("refuses to start an online payment for an invoice that is already paid", async () => {
    const t = await invoiceReadyToPayOnline();
    await webhook("payment.captured", t.order);
    expect(
      (await t.g.call("POST", `${t.g.base}/invoices/${t.invoice.id}/pay-online`)).statusCode,
    ).toBe(400);
  });
});
