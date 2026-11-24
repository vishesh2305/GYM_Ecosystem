import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { createDb, type DbHandle } from "./client";
import { auditLog, outboxEvents } from "./schema";
import { withTenant } from "./tenant";

const TENANT = "0193a1b2-0000-7000-8000-00000000000c";
let handle: DbHandle;

beforeAll(() => {
  handle = createDb(inject("databaseUrl"));
});
afterAll(async () => {
  await handle.pool.end();
});

/** Run raw SQL as the runtime role inside a rolled-back-on-error transaction. */
const asAppUser = (statement: string) =>
  handle.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql.raw(statement));
    })
    .catch((error: unknown) => {
      // Drizzle wraps driver errors; the Postgres message is on `cause`.
      throw (error as { cause?: unknown }).cause ?? error;
    });

describe("outbox_events", () => {
  it("app_user may only insert", async () => {
    await withTenant(handle.db, TENANT, (tx) =>
      tx.insert(outboxEvents).values({ type: "test.created", tenantId: TENANT, payload: { a: 1 } }),
    );
    await expect(asAppUser("select * from outbox_events")).rejects.toThrow(/permission denied/);
    await expect(asAppUser("update outbox_events set type = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(asAppUser("delete from outbox_events")).rejects.toThrow(/permission denied/);
  });
});

describe("worker-only tables", () => {
  it.each(["idempotency_keys", "handled_events"])("app_user has no access to %s", async (table) => {
    await expect(asAppUser(`select * from ${table}`)).rejects.toThrow(/permission denied/);
  });
});

describe("audit_log is append-only", () => {
  it("app_user may insert but not read, update or delete", async () => {
    await withTenant(handle.db, TENANT, (tx) =>
      tx.insert(auditLog).values({
        tenantId: TENANT,
        actorType: "staff",
        action: "membership.frozen",
        entityType: "membership",
        entityId: "m1",
      }),
    );
    await expect(asAppUser("select * from audit_log")).rejects.toThrow(/permission denied/);
    await expect(asAppUser("update audit_log set action = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(asAppUser("delete from audit_log")).rejects.toThrow(/permission denied/);
  });

  it("even the table owner cannot update, delete or truncate", async () => {
    const { pool } = handle;
    await expect(pool.query("update audit_log set action = 'tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
    await expect(pool.query("truncate audit_log")).rejects.toThrow(/append-only/);
    const { rows } = await pool.query("select action from audit_log");
    expect(rows.map((r) => r.action)).toContain("membership.frozen");
  });
});

describe("feature_flags", () => {
  it("app_user may read but not change flags", async () => {
    await expect(asAppUser("select * from feature_flags")).resolves.toBeUndefined();
    await expect(asAppUser("insert into feature_flags (key) values ('x')")).rejects.toThrow(
      /permission denied/,
    );
  });
});
