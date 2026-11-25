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

export const SET_KINDS = ["normal", "warmup", "drop", "failure"] as const;
export type SetKind = (typeof SET_KINDS)[number];

/** The records an exercise can hold, by what its sets record. */
export const RECORD_KINDS = {
  weight_reps: ["max_weight", "est_1rm", "best_set_volume"],
  reps: ["max_reps"],
  time: ["max_duration"],
  distance: ["max_distance"],
} as const satisfies Record<ExerciseTracking, readonly string[]>;
export type RecordKind = (typeof RECORD_KINDS)[ExerciseTracking][number];

export interface LoggedSet {
  id: string;
  kind: SetKind;
  reps: number | null;
  weightKg: number | null;
  durationSeconds: number | null;
  distanceM: number | null;
  /** When the set was ticked off; sets never ticked off do not count. */
  completedAt: Date | null;
}

export interface PersonalBest {
  value: number;
  setId: string;
  achievedAt: Date;
}

/** Above this many reps a one-rep-max estimate says little, so such sets do not set an estimated 1RM. */
export const MAX_REPS_FOR_1RM = 12;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Epley's estimate of the most weight lifted once; a single is its own 1RM. */
export const estimatedOneRepMax = (weightKg: number, reps: number) =>
  round2(reps === 1 ? weightKg : weightKg * (1 + reps / 30));

function valuesOf(tracking: ExerciseTracking, set: LoggedSet): Partial<Record<RecordKind, number>> {
  const positive = (n: number | null): n is number => n !== null && n > 0;
  switch (tracking) {
    case "weight_reps":
      if (!positive(set.weightKg) || !positive(set.reps)) return {};
      return {
        max_weight: set.weightKg,
        best_set_volume: round2(set.weightKg * set.reps),
        ...(set.reps <= MAX_REPS_FOR_1RM && {
          est_1rm: estimatedOneRepMax(set.weightKg, set.reps),
        }),
      };
    case "reps":
      return positive(set.reps) ? { max_reps: set.reps } : {};
    case "time":
      return positive(set.durationSeconds) ? { max_duration: set.durationSeconds } : {};
    case "distance":
      return positive(set.distanceM) ? { max_distance: set.distanceM } : {};
  }
}

/**
 * A person's best for each record of one exercise, from all their sets of it. Warm-ups and sets not ticked
 * off do not count. On a tie the earlier set keeps the record.
 */
export function personalBests(
  tracking: ExerciseTracking,
  sets: readonly LoggedSet[],
): Map<RecordKind, PersonalBest> {
  const best = new Map<RecordKind, PersonalBest>();
  const counted = sets
    .filter(
      (s): s is LoggedSet & { completedAt: Date } => s.completedAt !== null && s.kind !== "warmup",
    )
    .sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
  for (const set of counted) {
    for (const [kind, value] of Object.entries(valuesOf(tracking, set)) as [RecordKind, number][]) {
      const current = best.get(kind);
      if (!current || value > current.value)
        best.set(kind, { value, setId: set.id, achievedAt: set.completedAt });
    }
  }
  return best;
}
