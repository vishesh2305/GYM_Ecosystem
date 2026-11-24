import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, softDelete, timestamps } from "../columns";
import { users } from "./identity";
import { branches, organisations } from "./tenancy";

/** What a gym sells. Prices are in paise, before GST; a membership copies them when it is sold. */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    durationUnit: text("duration_unit", { enum: ["day", "month"] }).notNull(),
    durationCount: smallint("duration_count").notNull(),
    pricePaise: integer("price_paise").notNull(),
    gstRateBps: smallint("gst_rate_bps").notNull().default(1800),
    joiningFeePaise: integer("joining_fee_paise").notNull().default(0),
    isTrial: boolean("is_trial").notNull().default(false),
    /** Branches that sell this plan; empty = all branches. */
    branchIds: uuid("branch_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    maxFreezes: smallint("max_freezes").notNull().default(0),
    maxFreezeDays: smallint("max_freeze_days").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("plans_tenant_idx").on(t.tenantId),
    check("plans_price_non_negative", sql`${t.pricePaise} >= 0 and ${t.joiningFeePaise} >= 0`),
    check("plans_duration_positive", sql`${t.durationCount} > 0`),
    check("plans_gst_slab", sql`${t.gstRateBps} in (0, 500, 1200, 1800, 2800)`),
  ],
);

/** A gym's customer. May later be linked to an app account (userId) when they sign in with the same phone. */
export const members = pgTable(
  "members",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** E.164. */
    phone: text("phone"),
    /** Lower-cased. */
    email: text("email"),
    gender: text("gender", { enum: ["female", "male", "other", "unspecified"] }),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    homeBranchId: uuid("home_branch_id")
      .notNull()
      .references(() => branches.id),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    notes: text("notes"),
    source: text("source", { enum: ["manual", "import", "app"] })
      .notNull()
      .default("manual"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("members_tenant_phone_unique")
      .on(t.tenantId, t.phone)
      .where(sql`${t.phone} is not null and ${t.deletedAt} is null`),
    index("members_tenant_branch_idx").on(t.tenantId, t.homeBranchId),
  ],
);
