import { sql } from "drizzle-orm";
import { validate } from "uuid";
import type { Database } from "./client";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run `fn` in a transaction scoped to one tenant. Switches to the `app_user` role (subject to RLS)
 * and sets `app.tenant_id` for this transaction only, so it can never leak to the next pooled query.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!validate(tenantId)) throw new TypeError("tenantId must be a UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
