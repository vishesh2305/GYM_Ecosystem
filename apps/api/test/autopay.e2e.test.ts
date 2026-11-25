import { createDb, withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { autopayMandates, payments } from "@gym/db/schema";
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

type Gym = Awaited<ReturnType<typeof gymWithMember>>;

/** Waits for the worker to invoice the member and returns the invoices, newest first. */
async function invoicesOf(g: Gym, count = 1): Promise<{ id: string; totalPaise: number }[]> {
  let list: { id: string; totalPaise: number }[] = [];
  await vi.waitFor(
    async () => {
      list = (await g.call("GET", `${g.base}/members/${g.member.id}/invoices`)).json();
      expect(list.length).toBe(count);
    },
    { timeout: 15_000, interval: 100 },
  );
  return list;
}

/** A member with an unpaid first invoice and an AutoPay checkout started for it. */
async function autopayStarted() {
  const g = await gymWithMember(api, dbh.db);
  await g.enrol((await g.plan({})).id);
  const [invoice] = await invoicesOf(g);
  if (!invoice) throw new Error("no invoice");
  const res = await g.call("POST", `${g.base}/invoices/${invoice.id}/pay-autopay`);
  const autopayUrl = `${g.base}/members/${g.member.id}/autopay`;
  return { g, invoice, res, order: res.json(), autopayUrl, orgId: g.base.split("/").at(-1) ?? "" };
}

const mandateRow = (orgId: string, id: string) =>
  withTenant(dbh.db, orgId, (tx) =>
    tx.select().from(autopayMandates).where(eq(autopayMandates.id, id)),
  ).then((rows) => rows[0]);

describe("setting up UPI AutoPay", () => {
  it("opens a checkout for what is due that also asks the member to approve AutoPay", async () => {
    const t = await autopayStarted();
    expect(t.res.statusCode).toBe(201);
    expect(t.order).toMatchObject({
      gateway: "fake",
      amountPaise: 236_000,
      maxAmountPaise: 236_000,
      recurring: true,
      notes: { mandateId: t.order.mandateId },
    });
    expect(t.order.customerId).toMatch(/^cust_/);
    expect((await t.g.call("GET", t.autopayUrl)).json()).toMatchObject({
      id: t.order.mandateId,
      status: "pending",
      confirmedAt: null,
    });
  });

  it("is switched on when the first payment is captured with a token, and the invoice is paid", async () => {
    const t = await autopayStarted();
    const captured = await razorpayWebhook(api, "payment.captured", t.order, {
      extra: { token_id: "token_abc" },
    });
    expect(captured.statusCode).toBe(200);
    expect((await t.g.call("GET", t.autopayUrl)).json()).toMatchObject({ status: "active" });
    expect((await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}`)).json().status).toBe(
      "paid",
    );
    expect((await mandateRow(t.orgId, t.order.mandateId))?.gatewayTokenId).toBe("token_abc");
    const [payment] = await withTenant(dbh.db, t.orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.id, t.order.paymentId)),
    );
    expect(payment?.method).toBe("autopay");
  });

  it("is not switched on when the member declines or no token comes back", async () => {
    const declined = await autopayStarted();
    await razorpayWebhook(api, "payment.failed", declined.order);
    expect((await declined.g.call("GET", declined.autopayUrl)).statusCode).toBe(404);
    expect((await mandateRow(declined.orgId, declined.order.mandateId))?.status).toBe("failed");

    const noToken = await autopayStarted();
    await razorpayWebhook(api, "payment.captured", noToken.order);
    expect((await noToken.g.call("GET", noToken.autopayUrl)).statusCode).toBe(404);
  });

  it("replaces a set-up the member never approved, and a late approval of the old one changes nothing", async () => {
    const t = await autopayStarted();
    const again = (
      await t.g.call("POST", `${t.g.base}/invoices/${t.invoice.id}/pay-autopay`)
    ).json();
    expect((await t.g.call("GET", t.autopayUrl)).json().id).toBe(again.mandateId);
    expect((await mandateRow(t.orgId, t.order.mandateId))?.status).toBe("cancelled");
    await razorpayWebhook(api, "payment.captured", t.order, { extra: { token_id: "token_old" } });
    expect((await t.g.call("GET", t.autopayUrl)).json()).toMatchObject({
      id: again.mandateId,
      status: "pending",
    });
  });

  it("refuses a second set-up while AutoPay is on, and an invoice with nothing due", async () => {
    const t = await autopayStarted();
    await razorpayWebhook(api, "payment.captured", t.order, { extra: { token_id: "tok" } });
    expect(
      (await t.g.call("POST", `${t.g.base}/invoices/${t.invoice.id}/pay-autopay`)).statusCode,
    ).toBe(400);
    await t.g.enrol((await t.g.plan({ name: "Yearly" })).id, "2099-01-01");
    const [next] = await invoicesOf(t.g, 2);
    expect(
      (await t.g.call("POST", `${t.g.base}/invoices/${next?.id}/pay-autopay`)).statusCode,
    ).toBe(409);
  });

  it("can be turned off, after which there is nothing left to turn off", async () => {
    const t = await autopayStarted();
    await razorpayWebhook(api, "payment.captured", t.order, { extra: { token_id: "token_x" } });
    expect((await t.g.call("DELETE", t.autopayUrl)).statusCode).toBe(204);
    expect((await t.g.call("GET", t.autopayUrl)).statusCode).toBe(404);
    expect((await t.g.call("DELETE", t.autopayUrl)).statusCode).toBe(404);
    const mandate = await mandateRow(t.orgId, t.order.mandateId);
    expect(mandate?.status).toBe("cancelled");
    expect(mandate?.cancelledAt).toBeInstanceOf(Date);
  });
});
