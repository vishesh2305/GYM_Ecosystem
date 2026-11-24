import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, asc, desc, eq, inArray, sql } from "@gym/db/orm";
import { invoiceLines, invoices, ledgerEntries } from "@gym/db/schema";
import { Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { MembersService } from "../membership/members.service";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { DB } from "../tokens";

type InvoiceOut = z.output<typeof routes.getInvoice.response>;

async function withLines(tx: Tx, rows: (typeof invoices.$inferSelect)[]): Promise<InvoiceOut[]> {
  const lines = rows.length
    ? await tx
        .select()
        .from(invoiceLines)
        .where(
          inArray(
            invoiceLines.invoiceId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(invoiceLines.id))
    : [];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    number: r.number,
    status: r.status,
    memberId: r.memberId,
    membershipId: r.membershipId,
    relatedInvoiceId: r.relatedInvoiceId,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    sellerName: r.sellerName,
    sellerGstin: r.sellerGstin,
    buyerName: r.buyerName,
    placeOfSupply: r.placeOfSupply,
    taxablePaise: r.taxablePaise,
    cgstPaise: r.cgstPaise,
    sgstPaise: r.sgstPaise,
    igstPaise: r.igstPaise,
    totalPaise: r.totalPaise,
    paidPaise: r.paidPaise,
    lines: lines
      .filter((l) => l.invoiceId === r.id)
      .map((l) => ({
        description: l.description,
        sacCode: l.sacCode,
        taxablePaise: l.taxablePaise,
        gstRateBps: l.gstRateBps,
      })),
  }));
}

/** Money is visible to owners, managers and front desk; trainers do not see it. */
@TenantScoped()
@Roles("owner", "manager", "front_desk")
@Controller("orgs/:orgId")
export class InvoicesController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  @Get("members/:memberId/invoices")
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.listMemberInvoices.params)) params: { memberId: string },
  ): Promise<InvoiceOut[]> {
    await this.members.find(tenant, params.memberId);
    return withTenant(this.db.db, tenant.tenantId, async (tx) =>
      withLines(
        tx,
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.memberId, params.memberId))
          .orderBy(desc(invoices.id)),
      ),
    );
  }

  @Get("invoices/:invoiceId")
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.getInvoice.params)) params: { invoiceId: string },
  ): Promise<InvoiceOut> {
    const [row] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, params.invoiceId)),
    );
    if (!row) throw new NotFoundException("Invoice not found");
    await this.members.find(tenant, row.memberId);
    const [out] = await withTenant(this.db.db, tenant.tenantId, (tx) => withLines(tx, [row]));
    if (!out) throw new NotFoundException("Invoice not found");
    return out;
  }

  @Get("members/:memberId/balance")
  async balance(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.getMemberBalance.params)) params: { memberId: string },
  ): Promise<{ balancePaise: number }> {
    await this.members.find(tenant, params.memberId);
    const [row] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select({
          balance: sql<string>`coalesce(sum(${ledgerEntries.debitPaise} - ${ledgerEntries.creditPaise}), 0)`,
        })
        .from(ledgerEntries)
        .where(
          and(eq(ledgerEntries.account, "receivable"), eq(ledgerEntries.memberId, params.memberId)),
        ),
    );
    return { balancePaise: Number(row?.balance ?? 0) };
  }
}
