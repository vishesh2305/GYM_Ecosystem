import type { routes } from "@gym/contracts";
import { withUser, type Database, type DbHandle } from "@gym/db";
import { and, asc, desc, eq } from "@gym/db/orm";
import { bodyMetrics, consents, personalRecords, workouts, workoutTemplates } from "@gym/db/schema";
import { Body, Controller, Get, Inject, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";
import { CurrentAuth } from "./auth.guard";
import type { AuthContext } from "./auth.types";

type State = z.output<typeof routes.recordConsent.response>;
const toState = (row: typeof consents.$inferSelect): State => ({
  purpose: row.purpose,
  granted: row.granted,
  policyVersion: row.policyVersion,
  decidedAt: row.createdAt.toISOString(),
});

/** Training and body data are health data (DPDP Act 2023): kept only while the latest decision grants it. */
export async function hasHealthConsent(db: Database, userId: string): Promise<boolean> {
  const [latest] = await db
    .select({ granted: consents.granted })
    .from(consents)
    .where(and(eq(consents.userId, userId), eq(consents.purpose, "health_data")))
    .orderBy(desc(consents.createdAt), desc(consents.id))
    .limit(1);
  return latest?.granted ?? false;
}

/** On withdrawal the health data itself goes too; the person's own exercise names stay. */
async function eraseHealthData(db: Database, userId: string) {
  await withUser(db, userId, async (tx) => {
    await tx.delete(personalRecords);
    await tx.delete(workouts); // sets go with their workouts
    await tx.delete(workoutTemplates);
    await tx.delete(bodyMetrics);
  });
}

@Controller("me/consents")
export class ConsentsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async current(@CurrentAuth() auth: AuthContext): Promise<State[]> {
    const history = await this.db.db
      .select()
      .from(consents)
      .where(eq(consents.userId, auth.userId))
      .orderBy(asc(consents.createdAt), asc(consents.id));
    const latest = new Map(history.map((row) => [row.purpose, row]));
    return [...latest.values()].map(toState);
  }

  @Post()
  async record(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.recordConsent.body))
    body: z.output<typeof routes.recordConsent.body>,
    @Req() req: FastifyRequest,
  ): Promise<State> {
    const [row] = await this.db.db
      .insert(consents)
      .values({ userId: auth.userId, ...body, ip: req.ip, userAgent: req.headers["user-agent"] })
      .returning();
    if (!row) throw new Error("consent insert returned nothing");
    if (row.purpose === "health_data" && !row.granted)
      await eraseHealthData(this.db.db, auth.userId);
    return toState(row);
  }
}
