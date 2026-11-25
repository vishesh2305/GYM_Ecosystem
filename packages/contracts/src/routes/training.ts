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
