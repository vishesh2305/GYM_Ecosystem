import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { id } from "../columns";
import { members } from "./membership";
import { organisations } from "./tenancy";

/**
 * A member's gym pass: a TOTP secret (encrypted) from which the app draws a QR code that changes every 30 s.
 * `last_counter` is the newest time step accepted, so each code works once.
 */
export const memberPasses = pgTable(
  "member_passes",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    secretEnc: text("secret_enc").notNull(),
    lastCounter: integer("last_counter").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("member_passes_member_unique").on(t.tenantId, t.memberId)],
);
