import { createDb, type DbHandle } from "@gym/db";
import { addDays, todayIn } from "@gym/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createWorker, type WorkerHandle } from "../src/worker/create-worker";
import { gymWithMember, signedInStaff, testEnv } from "./helpers";

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

type Invoice = {
  kind: string;
  number: string;
  totalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  lines: { description: string }[];
};
async function invoicesFor(
  g: Awaited<ReturnType<typeof gymWithMember>>,
  count: number,
): Promise<Invoice[]> {
  let list: Invoice[] = [];
  await vi.waitFor(
    async () => {
      list = (await g.call("GET", `${g.base}/members/${g.member.id}/invoices`)).json();
      expect(list).toHaveLength(count);
    },
    { timeout: 15_000, interval: 100 },
  );
  return list;
}
const fy = () => {
  const t = todayIn("Asia/Kolkata");
  const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) >= 4 ? 0 : 1);
  return `${y % 100}-${(y + 1) % 100}`;
};

describe("invoices for membership sales", () => {
  it("each sale gets a GST invoice with membership and joining-fee lines, and the member owes the total", async () => {
    const g = await gymWithMember(api, dbh.db);
    const monthly = await g.plan({});
    await g.enrol(monthly.id);
    const [inv] = await invoicesFor(g, 1);
    expect(inv).toMatchObject({
      kind: "invoice",
      number: `INV/${fy()}/000001`,
      totalPaise: 236_000,
      cgstPaise: 18_000,
      sgstPaise: 18_000,
    });
    expect(inv?.lines.map((l) => l.description)).toEqual([
      expect.stringMatching(/^Monthly, /),
      "Joining fee",
    ]);
    expect((await g.call("GET", `${g.base}/members/${g.member.id}/balance`)).json()).toEqual({
      balancePaise: 236_000,
    });
  });

  it("numbers run on without gaps within a gym", async () => {
    const g = await gymWithMember(api, dbh.db);
    const monthly = await g.plan({});
    const first = (await g.enrol(monthly.id)).json();
    await g.enrol(monthly.id, addDays(first.endDate, 1));
    const list = await invoicesFor(g, 2);
    expect(list.map((i) => i.number).sort()).toEqual([`INV/${fy()}/000001`, `INV/${fy()}/000002`]);
  });

  it("free trials get no invoice", async () => {
    const g = await gymWithMember(api, dbh.db);
    const trial = await g.plan({
      name: "Trial",
      durationUnit: "day",
      durationCount: 7,
      pricePaise: 0,
      joiningFeePaise: 0,
      isTrial: true,
    });
    const monthly = await g.plan({});
    const t = (await g.enrol(trial.id)).json();
    await g.enrol(monthly.id, addDays(t.endDate, 1)); // the next sale proves the worker has caught up
    const list = await invoicesFor(g, 1);
    expect(list[0]?.lines[0]?.description).toMatch(/^Monthly/);
  });

  it("a plan change produces a credit note for the unused part, and the balance reflects it", async () => {
    const g = await gymWithMember(api, dbh.db);
    const monthly = await g.plan({});
    const yearly = await g.plan({
      name: "Yearly",
      durationCount: 12,
      pricePaise: 1_400_000,
      joiningFeePaise: 0,
    });
    const m = (await g.enrol(monthly.id)).json();
    const change = (
      await g.call("POST", `${g.base}/memberships/${m.id}/change-plan`, { planId: yearly.id })
    ).json();
    const list = await invoicesFor(g, 3);
    const note = list.find((i) => i.kind === "credit_note");
    const gst = Math.floor((change.creditPaise * 1800 + 5000) / 10_000);
    expect(note).toMatchObject({
      number: `CN/${fy()}/000001`,
      totalPaise: change.creditPaise + gst,
    });
    const invoiced = list.filter((i) => i.kind === "invoice").reduce((s, i) => s + i.totalPaise, 0);
    expect(
      (await g.call("GET", `${g.base}/members/${g.member.id}/balance`)).json().balancePaise,
    ).toBe(invoiced - (note?.totalPaise ?? 0));
  });

  it("GST-free plans are invoiced without tax, and one invoice can be fetched on its own", async () => {
    const g = await gymWithMember(api, dbh.db);
    const exempt = await g.plan({
      name: "Kids swim",
      gstRateBps: 0,
      joiningFeePaise: 0,
      pricePaise: 80_000,
    });
    await g.enrol(exempt.id);
    const [inv] = await invoicesFor(g, 1);
    expect(inv).toMatchObject({ totalPaise: 80_000, cgstPaise: 0, sgstPaise: 0 });
    const one = await g.call("GET", `${g.base}/invoices/${(inv as unknown as { id: string }).id}`);
    expect(one.json()).toMatchObject({
      number: inv?.number,
      lines: [{ sacCode: "999723", gstRateBps: 0 }],
    });
    expect(
      (await g.call("GET", `${g.base}/invoices/01930000-0000-7000-8000-00000000abcd`)).statusCode,
    ).toBe(404);
    const invoiceId = (inv as unknown as { id: string }).id;
    const pdf = await api.inject({
      method: "GET",
      url: `${g.base}/invoices/${invoiceId}/pdf`,
      headers: g.owner.headers,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain(`${inv?.number.replaceAll("/", "-")}.pdf`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.rawPayload.toString("latin1")).toContain(inv?.number ?? "missing");
  });

  it("trainers cannot see money", async () => {
    const g = await gymWithMember(api, dbh.db);
    const orgId = g.base.split("/").at(-1) ?? "";
    const trainer = await signedInStaff(api, dbh.db);
    const { withTenant } = await import("@gym/db");
    const { staffMembers } = await import("@gym/db/schema");
    await withTenant(dbh.db, orgId, (tx) =>
      tx.insert(staffMembers).values({ tenantId: orgId, userId: trainer.user.id, role: "trainer" }),
    );
    const res = await api.inject({
      method: "GET",
      url: `${g.base}/members/${g.member.id}/invoices`,
      headers: trainer.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});
