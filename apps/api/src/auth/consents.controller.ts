import type { routes } from "@gym/contracts";
import type { DbHandle } from "@gym/db";
import { asc, eq } from "@gym/db/orm";
import { consents } from "@gym/db/schema";
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
    return toState(row);
  }
}
