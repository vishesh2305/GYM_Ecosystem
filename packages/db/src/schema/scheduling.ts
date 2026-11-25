import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "../columns";
import { branches, organisations, staffMembers } from "./tenancy";

/** A weekly class on the timetable ("Yoga, Mon/Wed/Fri 07:00, 20 places"). Sessions are generated from it. */
export const classes = pgTable(
  "classes",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    description: text("description"),
    room: text("room"),
    instructorId: uuid("instructor_id").references(() => staffMembers.id),
    capacity: smallint("capacity").notNull(),
    durationMinutes: smallint("duration_minutes").notNull(),
    /** 0 = Sunday … 6 = Saturday. */
    weekdays: smallint("weekdays").array().notNull(),
    /** "HH:MM" in the gym's time zone. */
    startTime: text("start_time").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    /** Cancelling later than this before the start counts as a late cancellation. */
    cancelWindowMinutes: smallint("cancel_window_minutes").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    index("classes_branch_idx").on(t.tenantId, t.branchId),
    check("classes_capacity_positive", sql`${t.capacity} > 0`),
  ],
);

export const SESSION_KINDS = ["class", "pt"] as const;

/** One occurrence of a class, or a personal-training appointment (kind "pt", one place). */
export const classSessions = pgTable(
  "class_sessions",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    classId: uuid("class_id").references(() => classes.id),
    kind: text("kind", { enum: SESSION_KINDS }).notNull(),
    name: text("name").notNull(),
    room: text("room"),
    instructorId: uuid("instructor_id").references(() => staffMembers.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    capacity: smallint("capacity").notNull(),
    cancelWindowMinutes: smallint("cancel_window_minutes").notNull(),
    status: text("status", { enum: ["scheduled", "cancelled"] })
      .notNull()
      .default("scheduled"),
    cancelReason: text("cancel_reason"),
    /** Set once attendance has been settled after the session ended. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("class_sessions_class_start").on(t.classId, t.startsAt),
    index("class_sessions_branch_start_idx").on(t.tenantId, t.branchId, t.startsAt),
    check("class_sessions_capacity_positive", sql`${t.capacity} > 0`),
    check("class_sessions_ends_after_start", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
