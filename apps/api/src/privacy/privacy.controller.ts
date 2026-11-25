import type { routes } from "@gym/contracts";
import type { DbHandle } from "@gym/db";
import { and, desc, eq, gt, inArray } from "@gym/db/orm";
import { privacyRequests } from "@gym/db/schema";
import {
  ConflictException,
  Controller,
  Get,
  GoneException,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";

type RequestOut = z.output<typeof routes.listPrivacyRequests.response>[number];
type Row = typeof privacyRequests.$inferSelect;

export const toPrivacyRequest = (r: Row): RequestOut => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  requestedAt: r.requestedAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
});

/** The person's own privacy requests (DPDP Act 2023: right to access); the worker does the work. */
@Controller("me/privacy")
export class MyPrivacyController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post("exports")
  @HttpCode(202)
  async requestExport(@CurrentAuth() auth: AuthContext): Promise<RequestOut> {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [recent] = await this.db.db
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.userId, auth.userId),
          eq(privacyRequests.kind, "export"),
          inArray(privacyRequests.status, ["pending", "done"]),
          gt(privacyRequests.requestedAt, dayAgo),
        ),
      )
      .orderBy(desc(privacyRequests.requestedAt))
      .limit(1);
    if (recent) return toPrivacyRequest(recent);
    const [row] = await this.db.db
      .insert(privacyRequests)
      .values({ userId: auth.userId, kind: "export" })
      .returning();
    if (!row) throw new Error("privacy request insert returned nothing");
    return toPrivacyRequest(row);
  }

  @Get("requests")
  async list(@CurrentAuth() auth: AuthContext): Promise<RequestOut[]> {
    const rows = await this.db.db
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.userId, auth.userId))
      .orderBy(desc(privacyRequests.requestedAt));
    return rows.map(toPrivacyRequest);
  }

  @Get("exports/:requestId")
  @Header("content-disposition", 'attachment; filename="my-gym-data.json"')
  @Header("cache-control", "no-store")
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.downloadDataExport.params)) params: { requestId: string },
  ): Promise<Record<string, unknown>> {
    const [row] = await this.db.db
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.id, params.requestId),
          eq(privacyRequests.userId, auth.userId),
          eq(privacyRequests.kind, "export"),
        ),
      );
    if (!row) throw new NotFoundException("Export not found");
    if (row.status !== "done") throw new ConflictException("The export is not ready yet");
    if (!row.result) throw new GoneException("This export has expired; ask for a new one");
    return row.result as Record<string, unknown>;
  }
}
