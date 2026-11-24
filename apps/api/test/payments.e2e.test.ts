import { createDb, type DbHandle } from "@gym/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
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

/** A member with one unpaid invoice of ₹2,360 (236,000 paise). */
async function unpaidInvoice() {
  const g = await gymWithMember(api, dbh.db);
  await g.enrol((await g.plan({})).id);
  let invoice: { id: string; totalPaise: number } = { id: "", totalPaise: 0 };
  await vi.waitFor(
    async () => {
      [invoice] = (await g.call("GET", `${g.base}/members/${g.member.id}/invoices`)).json();
      expect(invoice?.id).toBeTruthy();
    },
    { timeout: 15_000, interval: 100 },
  );
  const pay = (body: object, key = `pay-${Math.random()}`) =>
    api.inject({
      method: "POST",
      url: `${g.base}/invoices/${invoice.id}/payments`,
      headers: { ...g.owner.headers, "idempotency-key": key },
      payload: body,
    });
  const balance = async () =>
    (await g.call("GET", `${g.base}/members/${g.member.id}/balance`)).json().balancePaise as number;
  const status = async () =>
    (await g.call("GET", `${g.base}/invoices/${invoice.id}`)).json() as {
      status: string;
      paidPaise: number;
    };
  return { g, invoice, pay, balance, status };
}

describe("payments at the desk", () => {
  it("part payment in cash, the rest by UPI: the invoice becomes paid and nothing is owed", async () => {
    const t = await unpaidInvoice();
    const cash = await t.pay({ method: "cash", amountPaise: 100_000 });
    expect(cash.statusCode).toBe(201);
    expect(await t.status()).toMatchObject({ status: "partially_paid", paidPaise: 100_000 });
    expect(await t.balance()).toBe(136_000);

    const upi = await t.pay({ method: "upi_qr", amountPaise: 136_000, reference: "UPI ref 4321" });
    expect(upi.json()).toMatchObject({
      method: "upi_qr",
      status: "captured",
      amountPaise: 136_000,
    });
    expect(await t.status()).toMatchObject({ status: "paid", paidPaise: 236_000 });
    expect(await t.balance()).toBe(0);

    const list = (await t.g.call("GET", `${t.g.base}/invoices/${t.invoice.id}/payments`)).json();
    expect(list.map((p: { method: string }) => p.method).sort()).toEqual(["cash", "upi_qr"]);
  });

  it("cannot take more than what is due", async () => {
    const t = await unpaidInvoice();
    const res = await t.pay({ method: "cash", amountPaise: 236_001 });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/more than/);
  });

  it("needs a retry key, and a retried request does not take the money twice", async () => {
    const t = await unpaidInvoice();
    const noKey = await api.inject({
      method: "POST",
      url: `${t.g.base}/invoices/${t.invoice.id}/payments`,
      headers: t.g.owner.headers,
      payload: { method: "cash", amountPaise: 1000 },
    });
    expect(noKey.statusCode).toBe(400);
    await t.pay({ method: "cash", amountPaise: 1000 }, "same-key");
    await t.pay({ method: "cash", amountPaise: 1000 }, "same-key");
    expect((await t.status()).paidPaise).toBe(1000);
  });

  it("refuses unknown invoices and credit notes", async () => {
    const t = await unpaidInvoice();
    const unknown = await api.inject({
      method: "POST",
      url: `${t.g.base}/invoices/01930000-0000-7000-8000-00000000abcd/payments`,
      headers: { ...t.g.owner.headers, "idempotency-key": "k-unknown" },
      payload: { method: "cash", amountPaise: 100 },
    });
    expect(unknown.statusCode).toBe(404);

    const ms = (await t.g.call("GET", `${t.g.base}/members/${t.g.member.id}/memberships`)).json();
    const yearly = await t.g.plan({
      name: "Yearly",
      durationCount: 12,
      pricePaise: 1_400_000,
      joiningFeePaise: 0,
    });
    await t.g.call("POST", `${t.g.base}/memberships/${ms[0].id}/change-plan`, {
      planId: yearly.id,
    });
    let note: { id: string } | undefined;
    await vi.waitFor(
      async () => {
        note = (await t.g.call("GET", `${t.g.base}/members/${t.g.member.id}/invoices`))
          .json()
          .find((i: { kind: string }) => i.kind === "credit_note");
        expect(note).toBeDefined();
      },
      { timeout: 15_000, interval: 100 },
    );
    const res = await api.inject({
      method: "POST",
      url: `${t.g.base}/invoices/${note?.id}/payments`,
      headers: { ...t.g.owner.headers, "idempotency-key": "k-note" },
      payload: { method: "cash", amountPaise: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("two desks taking the full amount at once: only one succeeds", async () => {
    const t = await unpaidInvoice();
    const results = await Promise.all([
      t.pay({ method: "cash", amountPaise: 236_000 }),
      t.pay({ method: "card_terminal", amountPaise: 236_000 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect((await t.status()).paidPaise).toBe(236_000);
  });
});
