import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { version } from "uuid";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { createDb, runMigrations, type DbHandle } from "./client";
import { id, softDelete, tenantId, timestamps } from "./columns";
import { withTenant } from "./tenant";

const items = pgTable("test_items", {
  id: id(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  ...timestamps,
  ...softDelete,
});

const TENANT_A = "0193a1b2-0000-7000-8000-00000000000a";
const TENANT_B = "0193a1b2-0000-7000-8000-00000000000b";

let handle: DbHandle;

beforeAll(async () => {
  handle = createDb(inject("databaseUrl"));
  const { db } = handle;
  await db.execute(sql`
    create table if not exists test_items (
      id uuid primary key,
      tenant_id uuid not null,
      name text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`);
  await db.execute(sql`select app.enable_tenant_rls('test_items')`);
  await withTenant(db, TENANT_A, (tx) =>
    tx.insert(items).values({ tenantId: TENANT_A, name: "a1" }),
  );
  await withTenant(db, TENANT_B, (tx) =>
    tx.insert(items).values({ tenantId: TENANT_B, name: "b1" }),
  );
});

afterAll(async () => {
  await handle.pool.end();
});

describe("migrations", () => {
  it("create the app schema and the non-bypass app_user role", async () => {
    const { rows } = await handle.pool.query(
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'app_user'",
    );
    expect(rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it("can be re-run without changes", async () => {
    await expect(runMigrations(handle.db)).resolves.toBeUndefined();
  });
});

describe("tenant isolation (RLS)", () => {
  it("a tenant sees only its own rows", async () => {
    const rows = await withTenant(handle.db, TENANT_A, (tx) => tx.select().from(items));
    expect(rows.map((r) => r.name)).toEqual(["a1"]);
  });

  it("no tenant context means no rows", async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      return tx.select().from(items);
    });
    expect(rows).toEqual([]);
  });

  it("cannot insert a row for another tenant", async () => {
    await expect(
      withTenant(handle.db, TENANT_A, (tx) =>
        tx.insert(items).values({ tenantId: TENANT_B, name: "x" }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(handle.db, TENANT_A, (tx) =>
      tx
        .update(items)
        .set({ name: "hacked" })
        .where(sql`tenant_id = ${TENANT_B}`)
        .returning(),
    );
    const deleted = await withTenant(handle.db, TENANT_A, (tx) =>
      tx
        .delete(items)
        .where(sql`tenant_id = ${TENANT_B}`)
        .returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("tenant context does not leak to the next transaction on the same pool", async () => {
    await withTenant(handle.db, TENANT_A, (tx) => tx.select().from(items));
    const { rows } = await handle.pool.query("select current_setting('app.tenant_id', true) as t");
    expect(rows[0].t ?? "").toBe("");
  });

  it("rejects a tenant id that is not a UUID", async () => {
    await expect(withTenant(handle.db, "1 or 1=1", async () => 1)).rejects.toThrow(TypeError);
  });
});

describe("base columns", () => {
  it("generate UUIDv7 ids and timestamps; updatedAt moves on update", async () => {
    const [row] = await withTenant(handle.db, TENANT_A, (tx) =>
      tx.insert(items).values({ tenantId: TENANT_A, name: "a2" }).returning(),
    );
    expect(row && version(row.id)).toBe(7);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.deletedAt).toBeNull();
    const [after] = await withTenant(handle.db, TENANT_A, (tx) =>
      tx
        .update(items)
        .set({ name: "a2b" })
        .where(sql`id = ${row?.id}`)
        .returning(),
    );
    expect(after && row && after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      row?.updatedAt.getTime() ?? 0,
    );
  });
});

describe("monthly partitions", () => {
  it("creates partitions idempotently and routes rows by month (UTC)", async () => {
    const { db, pool } = handle;
    await db.execute(sql`
      create table if not exists test_events (
        id uuid not null, tenant_id uuid not null, occurred_at timestamptz not null,
        primary key (tenant_id, occurred_at, id)
      ) partition by range (occurred_at)`);
    await db.execute(sql`select app.create_monthly_partitions('test_events', '2026-11-01', 3)`);
    await db.execute(sql`select app.create_monthly_partitions('test_events', '2026-11-01', 3)`);

    const parts = await pool.query(
      "select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'test_events'::regclass order by 1",
    );
    expect(parts.rows.map((r) => r.relname)).toEqual([
      "test_events_y2026m11",
      "test_events_y2026m12",
      "test_events_y2027m01",
    ]);

    await pool.query("insert into test_events values ($1, $2, '2026-11-30T23:30:00Z')", [
      "0193a1b2-0000-7000-8000-0000000000e1",
      TENANT_A,
    ]);
    const where = await pool.query("select tableoid::regclass::text as t from test_events");
    expect(where.rows[0].t).toBe("test_events_y2026m11");
  });
});
