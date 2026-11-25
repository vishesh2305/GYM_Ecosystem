import type { routes } from "@gym/contracts";
import { withUser, type DbHandle, type Tx } from "@gym/db";
import { eq } from "@gym/db/orm";
import { exercises, SET_KINDS, workouts, workoutSets, workoutTemplates } from "@gym/db/schema";
import { EQUIPMENT, EXERCISE_TRACKING, MUSCLES } from "@gym/domain";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";

type Operation = z.output<typeof routes.uploadSync.body>["batch"][number];

const iso = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const name = z.string().trim().min(1).max(100);
const notes = z.string().max(2000).nullable();
/** SQLite on the phone stores booleans as 0 / 1. */
const flag = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean);
const count = (max: number) => z.number().int().min(0).max(max).nullable();
const amount = (min: number, max: number) => z.number().min(min).max(max).nullable();

const templateExercises = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  },
  z
    .array(
      z.object({
        exercise_id: z.uuid(),
        sets: z.number().int().min(1).max(20),
        reps: count(1000).optional(),
        weight_kg: amount(0, 2000).optional(),
        rest_seconds: count(3600).optional(),
      }),
    )
    .max(50),
);

/**
 * What the app may write, per table, in the phone's column names. Nullable columns a PUT leaves out become
 * null (a PUT is the whole row); optional non-null columns keep their default. user_id, ids and timestamps
 * are never taken from the phone: unknown keys are dropped.
 */
const WRITABLE = {
  exercises: {
    table: exercises,
    columns: z.object({
      name,
      primary_muscle: z.enum(MUSCLES),
      equipment: z.enum(EQUIPMENT),
      tracking: z.enum(EXERCISE_TRACKING),
      archived: flag.optional(),
    }),
  },
  workouts: {
    table: workouts,
    columns: z.object({
      name,
      started_at: iso,
      ended_at: iso.nullable(),
      notes,
      template_id: z.uuid().nullable(),
    }),
  },
  workout_sets: {
    table: workoutSets,
    columns: z.object({
      workout_id: z.uuid(),
      exercise_id: z.uuid(),
      position: z.number().int().min(0).max(1000),
      kind: z.enum(SET_KINDS).optional(),
      reps: count(10_000),
      weight_kg: amount(0, 2000),
      rpe: amount(1, 10),
      duration_seconds: count(86_400),
      distance_m: count(1_000_000),
      completed_at: iso.nullable(),
    }),
  },
  workout_templates: {
    table: workoutTemplates,
    columns: z.object({ name, notes, exercises: templateExercises }),
  },
} as const;

type Spec = (typeof WRITABLE)[keyof typeof WRITABLE];

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The op's column values as table fields, or a 400 naming the operation. */
function fieldsOf(spec: Spec, op: Operation, index: number): Record<string, unknown> {
  const shape = spec.columns.shape as Record<string, z.ZodType>;
  const schema = op.op === "PATCH" ? spec.columns.partial() : spec.columns;
  const input: Record<string, unknown> = { ...op.data };
  // A PUT is the whole row: nullable columns it leaves out become null.
  if (op.op === "PUT")
    for (const [key, column] of Object.entries(shape))
      if (input[key] === undefined && column.safeParse(null).success) input[key] = null;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException(
      `Operation ${index} (${op.type} ${op.id}): ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
    );
  }
  const values = parsed.data as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(shape))
    if (values[key] !== undefined) fields[camel(key)] = values[key];
  return fields;
}

/** A set must point at one of my workouts and at an exercise I can see; otherwise it is skipped. */
async function referencesVisible(tx: Tx, fields: Record<string, unknown>): Promise<boolean> {
  if (typeof fields.workoutId === "string") {
    const [w] = await tx
      .select({ id: workouts.id })
      .from(workouts)
      .where(eq(workouts.id, fields.workoutId));
    if (!w) return false;
  }
  if (typeof fields.exerciseId === "string") {
    const [e] = await tx
      .select({ id: exercises.id })
      .from(exercises)
      .where(eq(exercises.id, fields.exerciseId));
    if (!e) return false;
  }
  return true;
}

/** Applies one operation; false when it was skipped because its row (or parent) is gone. */
async function applyOperation(tx: Tx, userId: string, op: Operation, index: number) {
  const spec = (WRITABLE as Record<string, Spec | undefined>)[op.type];
  if (!spec)
    throw new BadRequestException(`Operation ${index}: ${op.type} cannot be changed from the app`);
  // One generic code path for all four tables; each has id, user_id and updated_at.
  const table = spec.table as typeof workouts;
  const now = new Date();

  if (op.op === "DELETE") {
    // An own exercise is archived instead, so sets logged with it keep their exercise.
    const gone =
      spec.table === exercises
        ? await tx
            .update(exercises)
            .set({ archived: true, updatedAt: now })
            .where(eq(exercises.id, op.id))
            .returning({ id: exercises.id })
        : await tx.delete(table).where(eq(table.id, op.id)).returning({ id: table.id });
    return gone.length > 0;
  }

  const fields = fieldsOf(spec, op, index);
  if (!(await referencesVisible(tx, fields))) return false;
  if (op.op === "PATCH") {
    const changed = await tx
      .update(table)
      .set({ ...fields, updatedAt: now } as never)
      .where(eq(table.id, op.id))
      .returning({ id: table.id });
    return changed.length > 0;
  }
  // Another person's row with this id makes the upsert fail row-level security (403 for the batch).
  await tx
    .insert(table)
    .values({ ...fields, id: op.id, userId } as never)
    .onConflictDoUpdate({ target: table.id, set: { ...fields, updatedAt: now } as never });
  return true;
}

export type SyncResult = z.output<typeof routes.uploadSync.response>;

/** Applies a batch of offline changes in order, all or nothing, as the person who made them. */
export async function applySyncBatch(
  db: DbHandle["db"],
  userId: string,
  batch: readonly Operation[],
): Promise<SyncResult> {
  try {
    return await withUser(db, userId, async (tx) => {
      const result = { applied: 0, skipped: 0 };
      for (const [index, op] of batch.entries()) {
        if (await applyOperation(tx, userId, op, index)) result.applied++;
        else result.skipped++;
      }
      return result;
    });
  } catch (error) {
    const code =
      (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code === "42501")
      throw new ForbiddenException("These changes include rows that are not yours");
    throw error;
  }
}

@Controller("me/sync")
export class SyncController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post()
  @HttpCode(200)
  upload(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.uploadSync.body)) body: z.output<typeof routes.uploadSync.body>,
  ): Promise<SyncResult> {
    return applySyncBatch(this.db.db, auth.userId, body.batch);
  }
}
