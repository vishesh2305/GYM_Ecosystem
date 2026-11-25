import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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

export const CHECK_IN_METHODS = ["qr", "desk"] as const;

/** A visit: in when the member was let in, out when they left (or were checked out automatically). */
export const checkIns = pgTable(
  "check_ins",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    method: text("method", { enum: CHECK_IN_METHODS }).notNull(),
    kioskId: uuid("kiosk_id").references(() => kiosks.id),
    checkedInBy: uuid("checked_in_by"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  },
  (t) => [
    // One open visit per member: parallel scans cannot let the same person in twice.
    uniqueIndex("check_ins_one_open_per_member")
      .on(t.tenantId, t.memberId)
      .where(sql`${t.checkedOutAt} is null`),
    index("check_ins_open_by_branch")
      .on(t.tenantId, t.branchId)
      .where(sql`${t.checkedOutAt} is null`),
    index("check_ins_member_history").on(t.tenantId, t.memberId, t.checkedInAt),
  ],
);
