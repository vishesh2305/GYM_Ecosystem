import type { routes } from "@gym/contracts";
import { withUser, type DbHandle } from "@gym/db";
import { asc, desc, inArray, lt } from "@gym/db/orm";
import { workouts, workoutSets } from "@gym/db/schema";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";

type WorkoutOut = z.output<typeof routes.listMyWorkouts.response>[number];

@Controller("me/workouts")
export class MyWorkoutsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** The app reads its synced local copy; this is for the web and for checking what the server holds. */
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(contracts.listMyWorkouts.query))
    query: z.output<typeof routes.listMyWorkouts.query>,
  ): Promise<WorkoutOut[]> {
    return withUser(this.db.db, auth.userId, async (tx) => {
      const page = await tx
        .select()
        .from(workouts)
        .where(query.before ? lt(workouts.startedAt, new Date(query.before)) : undefined)
        .orderBy(desc(workouts.startedAt))
        .limit(query.limit ?? 20);
      const sets = page.length
        ? await tx
            .select()
            .from(workoutSets)
            .where(
              inArray(
                workoutSets.workoutId,
                page.map((w) => w.id),
              ),
            )
            .orderBy(asc(workoutSets.position))
        : [];
      return page.map((w) => ({
        id: w.id,
        name: w.name,
        startedAt: w.startedAt.toISOString(),
        endedAt: w.endedAt?.toISOString() ?? null,
        notes: w.notes,
        templateId: w.templateId,
        updatedAt: w.updatedAt.toISOString(),
        sets: sets
          .filter((s) => s.workoutId === w.id)
          .map((s) => ({
            id: s.id,
            exerciseId: s.exerciseId,
            position: s.position,
            kind: s.kind,
            reps: s.reps,
            weightKg: s.weightKg,
            rpe: s.rpe,
            durationSeconds: s.durationSeconds,
            distanceM: s.distanceM,
            completedAt: s.completedAt?.toISOString() ?? null,
          })),
      }));
    });
  }
}
