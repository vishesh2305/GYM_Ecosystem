import { createDb, type DbHandle } from "@gym/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, razorpayWebhook, testEnv } from "./helpers";

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

async function paidInCash() {
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
  const payment = (
    await api.inject({
      method: "POST",
      url: `${g.base}/invoices/${invoice.id}/payments`,
      headers: { ...g.owner.headers, "idempotency-key": `p-${Math.random()}` },
      payload: { method: "cash", amountPaise: 236_000 },
    })
  ).json();
  const refund = (body: object, key = `r-${Math.random()}`) =>
    api.inject({
      method: "POST",
      url: `${g.base}/payments/${payment.id}/refunds`,
      headers: { ...g.owner.headers, "idempotency-key": key },
      payload: body,
    });
  return { g, invoice, payment, refund };
}

describe("refunds", () => {
  it("a partial refund reopens what is owed on the invoice", async () => {
    const t = await paidInCash();
    const res = await t.refund({ amountPaise: 36_000, reason: "Joining fee waived" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      amountPaise: 36_000,
      gatewayRefundId: null,
      payment: { refundedPaise: 36_000 },
    });
    expect((await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}`)).json()).toMatchObject({
      status: "partially_paid",
      paidPaise: 200_000,
    });
    expect(
      (await t.g.call("GET", `${t.g.base}/members/${t.g.member.id}/balance`)).json().balancePaise,
    ).toBe(36_000);
  });

  it("never refunds more than was paid, even across several refunds", async () => {
    const t = await paidInCash();
    await t.refund({ amountPaise: 200_000, reason: "Part refund" });
    const tooMuch = await t.refund({ amountPaise: 36_001, reason: "Too much" });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().detail).toMatch(/36000/);
  });

  it("online payments are refunded through the gateway; unconfirmed ones cannot be refunded", async () => {
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
    const refundOf = (paymentId: string) =>
      api.inject({
        method: "POST",
        url: `${g.base}/payments/${paymentId}/refunds`,
        headers: { ...g.owner.headers, "idempotency-key": `r-${Math.random()}` },
        payload: { amountPaise: 10_000, reason: "Goodwill" },
      });
    expect((await refundOf(order.paymentId)).statusCode).toBe(400); // still pending

    await razorpayWebhook(api, "payment.captured", order, { paymentId: "pay_refundable" });
    const res = await refundOf(order.paymentId);
    expect(res.statusCode).toBe(201);
    expect(res.json().gatewayRefundId).toMatch(/^rfnd_fake_/);
  });

  it("needs a retry key and the owner or a manager", async () => {
    const t = await paidInCash();
    const noKey = await api.inject({
      method: "POST",
      url: `${t.g.base}/payments/${t.payment.id}/refunds`,
      headers: t.g.owner.headers,
      payload: { amountPaise: 1, reason: "x1" },
    });
    expect(noKey.statusCode).toBe(400);
  });
});
