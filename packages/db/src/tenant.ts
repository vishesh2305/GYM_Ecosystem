import { sql } from "drizzle-orm";
import { validate } from "uuid";
import type { Database } from "./client";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run `fn` in a transaction scoped to one tenant (organisation). Switches to the `app_user` role
 * (subject to RLS) and sets `app.tenant_id` for this transaction only, so it never leaks to the next
 * pooled query.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await scopeToTenant(tx, tenantId);
    return fn(tx);
  });
}

/** Scope an already-open transaction to one tenant (same rules as `withTenant`). */
export async function scopeToTenant(tx: Tx, tenantId: string): Promise<void> {
  if (!validate(tenantId)) throw new TypeError("tenantId must be a UUID");
  await tx.execute(sql`set local role app_user`);
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

/**
 * Run `fn` scoped to one person across tenants: RLS then shows only that person's own rows (their staff
 * memberships and the organisations they belong to). Used for "my gyms" and for checking membership.
 */
export async function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!validate(userId)) throw new TypeError("userId must be a UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
