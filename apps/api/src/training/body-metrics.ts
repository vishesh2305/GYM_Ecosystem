import type { routes } from "@gym/contracts";
import { withUser, type DbHandle } from "@gym/db";
import { desc, eq } from "@gym/db/orm";
import { bodyMetrics } from "@gym/db/schema";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";

/** shortcut: newest 500 only, no paging; add a before cursor if anyone logs more than that per kind. */
const LIMIT = 500;

@Controller("me/body-metrics")
export class MyBodyMetricsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(contracts.listMyBodyMetrics.query))
    query: z.output<typeof routes.listMyBodyMetrics.query>,
  ): Promise<z.output<typeof routes.listMyBodyMetrics.response>> {
    const rows = await withUser(this.db.db, auth.userId, (tx) =>
      tx
        .select()
        .from(bodyMetrics)
        .where(query.kind ? eq(bodyMetrics.kind, query.kind) : undefined)
        .orderBy(desc(bodyMetrics.measuredAt))
        .limit(LIMIT),
    );
    return rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    }));
  }
}
