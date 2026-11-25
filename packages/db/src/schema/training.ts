import { EXERCISE_TRACKING } from "@gym/domain";
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
