import { z } from "zod";
import { defineRoute } from "../route";

export const exercise = z.object({
  id: z.uuid(),
  name: z.string(),
  primaryMuscle: z.string(),
  secondaryMuscles: z.array(z.string()),
  equipment: z.string(),
  tracking: z.enum(["weight_reps", "reps", "time", "distance"]),
  mediaKey: z.string().nullable(),
  /** True for an exercise I created myself, false for the shared library. */
  mine: z.boolean(),
});

export const listExercises = defineRoute({
  method: "GET",
  path: "/v1/exercises",
  summary:
    "The exercise library plus my own exercises, optionally searched by name, muscle or equipment",
  tag: "training",
  query: z.object({
    q: z.string().trim().min(1).max(60).optional(),
    muscle: z.string().max(40).optional(),
    equipment: z.string().max(40).optional(),
  }),
  response: z.array(exercise),
});

export const syncOperation = z.object({
  op: z.enum(["PUT", "PATCH", "DELETE"]),
  /** The table: exercises, workouts, workout_sets or workout_templates. */
  type: z.string().max(40),
  id: z.uuid(),
  /** Column values in the phone's column names (snake_case). PUT sends the whole row, PATCH the changes. */
  data: z.record(z.string(), z.unknown()).optional(),
});

export const uploadSync = defineRoute({
  method: "POST",
  path: "/v1/me/sync",
  summary:
    "Upload changes the app made offline, in order, as one transaction. Retrying the same batch is safe. " +
    "Changes to rows deleted elsewhere are skipped; the last change to reach the server wins",
  tag: "training",
  body: z.object({ batch: z.array(syncOperation).min(1).max(1000) }),
  response: z.object({ applied: z.number().int(), skipped: z.number().int() }),
});

export const workoutSet = z.object({
  id: z.uuid(),
  exerciseId: z.uuid(),
  position: z.number().int(),
  kind: z.enum(["normal", "warmup", "drop", "failure"]),
  reps: z.number().int().nullable(),
  weightKg: z.number().nullable(),
  rpe: z.number().nullable(),
  durationSeconds: z.number().int().nullable(),
  distanceM: z.number().int().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

export const workout = z.object({
  id: z.uuid(),
  name: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  notes: z.string().nullable(),
  templateId: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
  sets: z.array(workoutSet),
});

export const listMyWorkouts = defineRoute({
  method: "GET",
  path: "/v1/me/workouts",
  summary: "My workouts with their sets, newest first; page with before = the last startedAt seen",
  tag: "training",
  query: z.object({
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
  response: z.array(workout),
});

export const listMyRecords = defineRoute({
  method: "GET",
  path: "/v1/me/personal-records",
  summary:
    "My personal records per exercise (max_weight, est_1rm, best_set_volume, max_reps, max_duration, max_distance), " +
    "recalculated whenever sets are uploaded",
  tag: "training",
  response: z.array(
    z.object({
      exerciseId: z.uuid(),
      exerciseName: z.string(),
      kind: z.enum([
        "max_weight",
        "est_1rm",
        "best_set_volume",
        "max_reps",
        "max_duration",
        "max_distance",
      ]),
      value: z.number(),
      setId: z.uuid(),
      achievedAt: z.iso.datetime(),
    }),
  ),
});
