import { timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 } from "uuid";

/** UUIDv7 primary key: time-ordered, so inserts stay index-friendly. */
export const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => v7());

/** Every tenant table has this column, protected by `app.enable_tenant_rls`. */
export const tenantId = () => uuid("tenant_id").notNull();

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const softDelete = {
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};
