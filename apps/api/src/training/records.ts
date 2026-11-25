import type { routes } from "@gym/contracts";
import { withUser, type DbHandle, type Tx } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { exercises, personalRecords, workoutSets } from "@gym/db/schema";
import { personalBests } from "@gym/domain";
import { Controller, Get, Inject } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { appendEvent, defineEvent } from "../platform/events";
import { DB } from "../tokens";

/** A record was beaten (or set for the first time), for the app to celebrate and notifications (A14). */
export const personalRecordSet = defineEvent(
  "training.personal_record_set",
  z.object({
    userId: z.uuid(),
    exerciseId: z.uuid(),
    kind: z.string(),
    value: z.number(),
    previous: z.number().nullable(),
  }),
);

/**
 * Recalculates the caller's records for these exercises from all their sets, inside the caller's tx (RLS
 * scopes everything to the person). Only a better value raises an event; a lower one after a deletion or an
 * edit quietly replaces the old record.
 */
export async function refreshRecords(tx: Tx, userId: string, exerciseIds: Iterable<string>) {
  for (const exerciseId of exerciseIds) {
    const [exercise] = await tx
      .select({ tracking: exercises.tracking })
      .from(exercises)
      .where(eq(exercises.id, exerciseId));
    if (!exercise) continue;
    const sets = await tx.select().from(workoutSets).where(eq(workoutSets.exerciseId, exerciseId));
    const best = personalBests(exercise.tracking, sets);
    const current = await tx
      .select()
      .from(personalRecords)
      .where(eq(personalRecords.exerciseId, exerciseId));

    for (const old of current)
      if (!best.has(old.kind))
        await tx.delete(personalRecords).where(eq(personalRecords.id, old.id));
    for (const [kind, record] of best) {
      const old = current.find((r) => r.kind === kind);
      if (old?.value === record.value && old.setId === record.setId) continue;
      const fields = { value: record.value, setId: record.setId, achievedAt: record.achievedAt };
      await tx
        .insert(personalRecords)
        .values({ userId, exerciseId, kind, ...fields })
        .onConflictDoUpdate({
          target: [personalRecords.userId, personalRecords.exerciseId, personalRecords.kind],
          set: { ...fields, updatedAt: new Date() },
        });
      if (!old || record.value > old.value)
        await appendEvent(
          tx,
          personalRecordSet,
          { userId, exerciseId, kind, value: record.value, previous: old?.value ?? null },
          null,
        );
    }
  }
}

type RecordOut = z.output<typeof routes.listMyRecords.response>[number];

@Controller("me/personal-records")
export class MyRecordsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async list(@CurrentAuth() auth: AuthContext): Promise<RecordOut[]> {
    const rows = await withUser(this.db.db, auth.userId, (tx) =>
      tx
        .select({ record: personalRecords, exerciseName: exercises.name })
        .from(personalRecords)
        .innerJoin(exercises, eq(exercises.id, personalRecords.exerciseId))
        .orderBy(asc(exercises.name), asc(personalRecords.kind)),
    );
    return rows.map(({ record, exerciseName }) => ({
      exerciseId: record.exerciseId,
      exerciseName,
      kind: record.kind,
      value: record.value,
      setId: record.setId,
      achievedAt: record.achievedAt.toISOString(),
    }));
  }
}
