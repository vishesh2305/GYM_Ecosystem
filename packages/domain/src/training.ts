/** Muscle groups used to tag exercises (primary and secondary). */
export const MUSCLES = [
  "chest",
  "back",
  "lats",
  "traps",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "abs",
  "obliques",
  "lower_back",
  "glutes",
  "quadriceps",
  "hamstrings",
  "calves",
  "adductors",
  "abductors",
  "full_body",
  "cardio",
] as const;
export type Muscle = (typeof MUSCLES)[number];

export const EQUIPMENT = [
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "smith_machine",
  "ez_bar",
  "trap_bar",
  "band",
  "bodyweight",
  "cardio_machine",
  "other",
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

/** What a set of this exercise records, which decides the personal records it can set. */
export const EXERCISE_TRACKING = ["weight_reps", "reps", "time", "distance"] as const;
export type ExerciseTracking = (typeof EXERCISE_TRACKING)[number];
