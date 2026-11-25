import { createDb, withTenant, type DbHandle } from "@gym/db";
import { and, eq } from "@gym/db/orm";
import { addDays } from "@gym/domain";
import { autopayMandates, payments } from "@gym/db/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { runAutopayRenewals } from "../src/billing/autopay-renewals";
import { FakeGateway } from "../src/billing/gateway";
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

const HOUR = 3_600_000;
const later = (at: Date, hours: number) => new Date(at.getTime() + hours * HOUR);

class RefusingGateway extends FakeGateway {
  override async chargeMandate(): Promise<{ orderId: string }> {
    throw new Error("token expired");
  }
}

/** AutoPay on, and `at` is a moment (in the gym's time zone) two days before the membership's last day. */
async function renewalDue() {
  const t = await autopayStarted();
  await razorpayWebhook(api, "payment.captured", t.order, { extra: { token_id: "token_r" } });
  const membershipsUrl = `${t.g.base}/members/${t.g.member.id}/memberships`;
  const [membership] = (await t.g.call("GET", membershipsUrl)).json();
  const at = new Date(`${addDays(membership.endDate, -2)}T06:00:00Z`);
  return { ...t, membership, membershipsUrl, at };
}

async function renewalInvoice(t: Awaited<ReturnType<typeof renewalDue>>) {
  const list = await invoicesOf(t.g, 2);
  const invoice = list.find((i) => i.id !== t.invoice.id);
  if (!invoice) throw new Error("no renewal invoice");
  return invoice;
}

const autopayTries = (orgId: string, invoiceId: string) =>
  withTenant(dbh.db, orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.method, "autopay"))),
  );

describe("renewing with AutoPay", () => {
  it("renews on the same plan from the day after the membership ends, once, without a joining fee", async () => {
    const t = await renewalDue();
    // Four days before the end is too early.
    await runAutopayRenewals(dbh.db, new FakeGateway(), later(t.at, -48));
    expect((await t.g.call("GET", t.membershipsUrl)).json()).toHaveLength(1);

    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    const [next, current] = (await t.g.call("GET", t.membershipsUrl)).json();
    expect(current.id).toBe(t.membership.id);
    expect(next).toMatchObject({
      status: "pending",
      planId: t.membership.planId,
      startDate: addDays(t.membership.endDate, 1),
      joiningFeePaise: 0,
      totalPaise: 177_000,
    });
  });

  it("charges the renewal invoice to the mandate once, and the webhook marks it paid", async () => {
    const t = await renewalDue();
    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    const invoice = await renewalInvoice(t);
    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    // Still waiting for the webhook a day later: never charged again.
    await runAutopayRenewals(dbh.db, new FakeGateway(), later(t.at, 30));
    const tries = await autopayTries(t.orgId, invoice.id);
    expect(tries).toHaveLength(1);
    const [charge] = tries;
    expect(charge).toMatchObject({ status: "pending", amountPaise: 177_000 });

    await razorpayWebhook(api, "payment.captured", {
      orderId: charge?.gatewayOrderId ?? "",
      amountPaise: 177_000,
      notes: { tenantId: t.orgId, paymentId: charge?.id ?? "" },
    });
    expect((await t.g.call("GET", `${t.g.base}/invoices/${invoice.id}`)).json().status).toBe(
      "paid",
    );
  });

  it("retries a refused charge after a day, three times at most", async () => {
    const t = await renewalDue();
    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    const invoice = await renewalInvoice(t);
    const refusing = new RefusingGateway();
    const first = await runAutopayRenewals(dbh.db, refusing, t.at);
    expect(first.errors.some((e) => e.endsWith("token expired"))).toBe(true);
    await runAutopayRenewals(dbh.db, refusing, later(t.at, 1));
    expect(await autopayTries(t.orgId, invoice.id)).toHaveLength(1);
    for (const hours of [21, 42, 63])
      await runAutopayRenewals(dbh.db, refusing, later(t.at, hours));
    const tries = await autopayTries(t.orgId, invoice.id);
    expect(tries.map((p) => p.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("does not charge more than the member approved", async () => {
    const t = await renewalDue();
    await t.g.call("PATCH", `${t.g.base}/plans/${t.membership.planId}`, { pricePaise: 300_000 });
    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    const invoice = await renewalInvoice(t);
    expect(invoice.totalPaise).toBe(354_000);
    await runAutopayRenewals(dbh.db, new FakeGateway(), t.at);
    expect(await autopayTries(t.orgId, invoice.id)).toHaveLength(0);
  });

  it("renews nothing when the plan is no longer sold or AutoPay was turned off", async () => {
    const archived = await renewalDue();
    await archived.g.call("PATCH", `${archived.g.base}/plans/${archived.membership.planId}`, {
      active: false,
    });
    const result = await runAutopayRenewals(dbh.db, new FakeGateway(), archived.at);
    expect(result.skipped).toBeGreaterThan(0);
    expect((await archived.g.call("GET", archived.membershipsUrl)).json()).toHaveLength(1);

    const off = await renewalDue();
    await off.g.call("DELETE", off.autopayUrl);
    await runAutopayRenewals(dbh.db, new FakeGateway(), off.at);
    expect((await off.g.call("GET", off.membershipsUrl)).json()).toHaveLength(1);
  });

  it("is run hourly by the worker", async () => {
    const keys = (await worker.maintenanceQueue.getJobSchedulers()).map((s) => s.key);
    expect(keys).toContain("autopay-renewals-hourly");
    const job = await worker.maintenanceQueue.add("autopay-renewals", {});
    await vi.waitFor(async () => expect(await job.getState()).toBe("completed"), {
      timeout: 15_000,
      interval: 100,
    });
  });
});
