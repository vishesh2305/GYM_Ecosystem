import type { routes } from "@gym/contracts";
import { withUser, type DbHandle } from "@gym/db";
import { and, asc, eq, ilike, or, sql } from "@gym/db/orm";
import { exercises } from "@gym/db/schema";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { escapeLike } from "../membership/members.service";
import { DB } from "../tokens";

type ExerciseOut = z.output<typeof routes.listExercises.response>[number];

export const toExercise = (e: typeof exercises.$inferSelect): ExerciseOut => ({
  id: e.id,
  name: e.name,
  primaryMuscle: e.primaryMuscle,
  secondaryMuscles: e.secondaryMuscles,
  equipment: e.equipment,
  tracking: e.tracking,
  mediaKey: e.mediaKey,
  mine: e.userId !== null,
});

@Controller("exercises")
export class ExercisesController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** RLS shows the shared library and the caller's own exercises, never anyone else's. */
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(contracts.listExercises.query))
    query: z.output<typeof routes.listExercises.query>,
  ): Promise<ExerciseOut[]> {
    const rows = await withUser(this.db.db, auth.userId, (tx) =>
      tx
        .select()
        .from(exercises)
        .where(
          and(
            eq(exercises.archived, false),
            query.q ? ilike(exercises.name, `%${escapeLike(query.q)}%`) : undefined,
            query.muscle
              ? or(
                  eq(exercises.primaryMuscle, query.muscle),
                  sql`${query.muscle} = any(${exercises.secondaryMuscles})`,
                )
              : undefined,
            query.equipment ? eq(exercises.equipment, query.equipment) : undefined,
          ),
        )
        .orderBy(asc(exercises.name)),
    );
    return rows.map(toExercise);
  }
}
