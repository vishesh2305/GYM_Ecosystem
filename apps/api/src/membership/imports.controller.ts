import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { memberImports } from "@gym/db/schema";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import { assertBranchesExist } from "../tenancy/branch-checks";
import {
  CurrentTenant,
  isBranchScoped,
  Roles,
  TenantScoped,
  type TenantContext,
} from "../tenancy/tenant.guard";
import { DB, ENV } from "../tokens";
import { parseMemberCsv } from "./csv-import";
import { memberImportRequested } from "./import.handler";

type ImportOut = z.output<typeof routes.getMemberImport.response>;
const toImport = (r: typeof memberImports.$inferSelect): ImportOut => ({
  id: r.id,
  status: r.status,
  fileName: r.fileName,
  totalRows: r.totalRows,
  createdCount: r.createdCount,
  failedCount: r.failedCount,
  errors: r.errors,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

@TenantScoped()
@Roles("owner", "manager")
@Controller("orgs/:orgId/member-imports")
export class MemberImportsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post()
  @HttpCode(202)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.createMemberImport.body))
    body: z.output<typeof routes.createMemberImport.body>,
  ): Promise<ImportOut> {
    if (isBranchScoped(tenant))
      throw new ForbiddenException("Only staff who look after every branch can import members");
    let totalRows: number;
    try {
      totalRows = parseMemberCsv(body.csv).length;
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return withTenant(this.db.db, tenant.tenantId, async (tx) => {
      await assertBranchesExist(tx, [body.defaultBranchId]);
      const [row] = await tx
        .insert(memberImports)
        .values({
          tenantId: tenant.tenantId,
          fileName: body.fileName,
          content: body.csv,
          defaultBranchId: body.defaultBranchId,
          totalRows,
          createdBy: tenant.staffId,
        })
        .returning();
      if (!row) throw new Error("import insert returned nothing");
      await appendEvent(
        tx,
        memberImportRequested,
        { importId: row.id, phoneRegion: this.env.DEFAULT_PHONE_REGION },
        tenant.tenantId,
      );
      await recordAudit(tx, {
        tenantId: tenant.tenantId,
        actorType: "staff",
        actorId: tenant.staffId,
        action: "member_import.requested",
        entityType: "member_import",
        entityId: row.id,
        data: { totalRows },
      });
      return toImport(row);
    });
  }

  @Get(":importId")
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.getMemberImport.params)) params: { importId: string },
  ): Promise<ImportOut> {
    const [row] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(memberImports).where(eq(memberImports.id, params.importId)),
    );
    if (!row) throw new NotFoundException("Import not found");
    return toImport(row);
  }
}
