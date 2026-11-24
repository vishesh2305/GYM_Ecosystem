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
  timestamp,
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

export const MEMBERSHIP_STATUSES = [
  "pending",
  "trial",
  "active",
  "frozen",
  "expired",
  "cancelled",
] as const;

/** A plan sold to a member for a period. Prices are copied from the plan at the time of sale. */
export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    planName: text("plan_name").notNull(),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull(),
    /** Inclusive calendar dates in the gym's time zone. */
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    isTrial: boolean("is_trial").notNull(),
    pricePaise: integer("price_paise").notNull(),
    joiningFeePaise: integer("joining_fee_paise").notNull(),
    gstRateBps: smallint("gst_rate_bps").notNull(),
    gstPaise: integer("gst_paise").notNull(),
    totalPaise: integer("total_paise").notNull(),
    maxFreezes: smallint("max_freezes").notNull(),
    maxFreezeDays: smallint("max_freeze_days").notNull(),
    freezesUsed: smallint("freezes_used").notNull().default(0),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    index("memberships_member_idx").on(t.tenantId, t.memberId),
    index("memberships_status_end_idx").on(t.tenantId, t.status, t.endDate),
    check("memberships_dates_ordered", sql`${t.startDate} <= ${t.endDate}`),
  ],
);

/** A pause of a membership. While frozen, the membership's end date moves back by `days`. */
export const membershipFreezes = pgTable(
  "membership_freezes",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    plannedEndsOn: date("planned_ends_on", { mode: "string" }).notNull(),
    endedOn: date("ended_on", { mode: "string" }),
    days: smallint("days").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("membership_freezes_membership_idx").on(t.tenantId, t.membershipId)],
);
