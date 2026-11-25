import { BODY_METRICS, EXERCISE_TRACKING, SET_KINDS, type RecordKind } from "@gym/domain";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "../columns";
import { users } from "./identity";

/**
 * Training data belongs to the person, not to a gym: it follows them between gyms and stays when they leave.
 * Every table here is protected by `app.enable_user_rls` (rows of `app.user_id` only), except the shared
 * exercise library, which everyone can read.
 */

/** The shared exercise library (user_id null, seeded by migration) plus each person's own exercises. */
export const exercises = pgTable(
  "exercises",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Stable key for library exercises, e.g. "barbell-bench-press". Null for a person's own. */
    slug: text("slug"),
    name: text("name").notNull(),
    primaryMuscle: text("primary_muscle").notNull(),
    secondaryMuscles: text("secondary_muscles")
      .array()
      .notNull()
      .default(sql`'{}'`),
    equipment: text("equipment").notNull(),
    tracking: text("tracking", { enum: EXERCISE_TRACKING }).notNull(),
    /** Object-storage key of the how-to video, once it has been filmed. */
    mediaKey: text("media_key"),
    /** A person's own exercise is archived rather than deleted, so old sets keep their exercise. */
    archived: boolean("archived").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("exercises_slug_key").on(t.slug), index("exercises_user_idx").on(t.userId)],
);

const tz = { withTimezone: true } as const;

/**
 * Rows the app writes offline carry ids made on the phone (UUIDs), so a retried upload updates the same row
 * instead of duplicating it. `updated_at` is always the server's time of the last accepted write.
 */
export const workouts = pgTable(
  "workouts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startedAt: timestamp("started_at", tz).notNull(),
    endedAt: timestamp("ended_at", tz),
    notes: text("notes"),
    /** The template it was started from, if any (no foreign key: templates can be deleted). */
    templateId: uuid("template_id"),
    ...timestamps,
  },
  (t) => [index("workouts_user_started_idx").on(t.userId, t.startedAt)],
);

/** One set. `user_id` repeats the workout's owner so access rules and sync need no join. */
export const workoutSets = pgTable(
  "workout_sets",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    position: smallint("position").notNull(),
    kind: text("kind", { enum: SET_KINDS }).notNull().default("normal"),
    reps: smallint("reps"),
    weightKg: doublePrecision("weight_kg"),
    rpe: doublePrecision("rpe"),
    durationSeconds: integer("duration_seconds"),
    distanceM: integer("distance_m"),
    /** Set when the member ticks the set off; only completed sets count towards records. */
    completedAt: timestamp("completed_at", tz),
    ...timestamps,
  },
  (t) => [
    index("workout_sets_workout_idx").on(t.workoutId),
    index("workout_sets_user_exercise_idx").on(t.userId, t.exerciseId),
    check(
      "workout_sets_values_non_negative",
      sql`${t.reps} >= 0 and ${t.weightKg} >= 0 and ${t.durationSeconds} >= 0 and ${t.distanceM} >= 0`,
    ),
  ],
);

/** A reusable workout plan: [{ exercise_id, sets, reps?, weight_kg?, rest_seconds? }]. */
export const workoutTemplates = pgTable("workout_templates", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  notes: text("notes"),
  exercises: jsonb("exercises")
    .notNull()
    .default(sql`'[]'`),
  ...timestamps,
});

/**
 * A person's current best per exercise and record kind, kept up to date by the server whenever sets are
 * uploaded. Read-only for the app, which receives it through sync.
 */
export const personalRecords = pgTable(
  "personal_records",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    kind: text("kind").$type<RecordKind>().notNull(),
    value: doublePrecision("value").notNull(),
    /** No foreign key: when the set goes, the record is recalculated in the same transaction. */
    setId: uuid("set_id").notNull(),
    achievedAt: timestamp("achieved_at", tz).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("personal_records_user_exercise_kind_key").on(t.userId, t.exerciseId, t.kind),
  ],
);

/** One body measurement (weight, body fat, a tape measurement, resting heart rate) at a moment in time. */
export const bodyMetrics = pgTable(
  "body_metrics",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: BODY_METRICS }).notNull(),
    value: doublePrecision("value").notNull(),
    measuredAt: timestamp("measured_at", tz).notNull(),
    ...timestamps,
  },
  (t) => [
    index("body_metrics_user_kind_idx").on(t.userId, t.kind, t.measuredAt),
    check("body_metrics_value_positive", sql`${t.value} > 0`),
  ],
);
