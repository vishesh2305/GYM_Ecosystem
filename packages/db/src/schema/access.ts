import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { id } from "../columns";
import { members } from "./membership";
import { branches, organisations } from "./tenancy";

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

/** A check-in device at a branch (tablet or scanner). Its token is stored only as a SHA-256 hash. */
export const kiosks = pgTable(
  "kiosks",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: uuid("created_by"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("kiosks_token_unique").on(t.tokenHash)],
);
