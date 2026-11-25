import type { routes } from "@gym/contracts";
import { withTenant, withUser, type DbHandle } from "@gym/db";
import { and, count, desc, eq, gt, inArray, ne } from "@gym/db/orm";
import { organisations, privacyRequests, staffMembers } from "@gym/db/schema";
import {
  Body,
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
import { SessionService } from "../auth/session.service";
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
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

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

  /**
   * Starts erasure: refuses while the person is the only owner of a gym, then signs them out everywhere and
   * queues the request for the worker (repeating the request returns the pending one).
   */
  @Post("erasure")
  @HttpCode(202)
  async requestErasure(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.requestErasure.body)) _body: { confirm: string },
  ): Promise<RequestOut> {
    const owned = await withUser(this.db.db, auth.userId, (tx) =>
      tx
        .select({ tenantId: staffMembers.tenantId })
        .from(staffMembers)
        .where(
          and(
            eq(staffMembers.userId, auth.userId),
            eq(staffMembers.role, "owner"),
            eq(staffMembers.status, "active"),
          ),
        ),
    );
    for (const { tenantId } of owned) {
      const others = await withTenant(this.db.db, tenantId, async (tx) => {
        const [org] = await tx
          .select({ name: organisations.name, deletedAt: organisations.deletedAt })
          .from(organisations);
        const [row] = await tx
          .select({ n: count() })
          .from(staffMembers)
          .where(
            and(
              eq(staffMembers.role, "owner"),
              eq(staffMembers.status, "active"),
              ne(staffMembers.userId, auth.userId),
            ),
          );
        return { org, owners: row?.n ?? 0 };
      });
      if (others.org && !others.org.deletedAt && others.owners === 0)
        throw new ConflictException(
          `You are the only owner of ${others.org.name}. Make someone else an owner first.`,
        );
    }
    const [pending] = await this.db.db
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.userId, auth.userId),
          eq(privacyRequests.kind, "erasure"),
          eq(privacyRequests.status, "pending"),
        ),
      );
    await this.sessions.revokeAll(auth.userId, "account_erasure");
    if (pending) return toPrivacyRequest(pending);
    const [row] = await this.db.db
      .insert(privacyRequests)
      .values({ userId: auth.userId, kind: "erasure" })
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
