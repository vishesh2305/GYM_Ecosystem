import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { v7 } from "uuid";
import { createDb, type DbHandle } from "./client";
import { ledgerEntries, organisations } from "./schema";
import { withTenant } from "./tenant";

let handle: DbHandle;
const org = v7();

beforeAll(async () => {
  handle = createDb(inject("databaseUrl"));
  await withTenant(handle.db, org, (tx) =>
    tx.insert(organisations).values({ id: org, name: "Ledger Gym" }),
  );
});
afterAll(async () => {
  await handle.pool.end();
});

const line = (
  journalId: string,
  account: "receivable" | "revenue",
  debit: number,
  credit: number,
) => ({
  tenantId: org,
  journalId,
  account,
  debitPaise: debit,
  creditPaise: credit,
  sourceType: "test",
  sourceId: journalId,
});

describe("ledger", () => {
  it("accepts a balanced journal", async () => {
    const j = v7();
    await withTenant(handle.db, org, (tx) =>
      tx
        .insert(ledgerEntries)
        .values([line(j, "receivable", 1000, 0), line(j, "revenue", 0, 1000)]),
    );
    const rows = await withTenant(handle.db, org, (tx) => tx.select().from(ledgerEntries));
    expect(rows.filter((r) => r.journalId === j)).toHaveLength(2);
  });

  it("refuses to commit an unbalanced journal", async () => {
    const j = v7();
    await expect(
      withTenant(handle.db, org, (tx) =>
        tx
          .insert(ledgerEntries)
          .values([line(j, "receivable", 1000, 0), line(j, "revenue", 0, 999)]),
      ),
    ).rejects.toThrow();
    const rows = await withTenant(handle.db, org, (tx) => tx.select().from(ledgerEntries));
    expect(rows.some((r) => r.journalId === j)).toBe(false);
  });

  it("can never be changed or deleted, even by the table owner", async () => {
    await expect(handle.pool.query("update ledger_entries set debit_paise = 1")).rejects.toThrow(
      /append-only/,
    );
    await expect(handle.pool.query("delete from ledger_entries")).rejects.toThrow(/append-only/);
  });
});
