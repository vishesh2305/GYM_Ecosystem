import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle } from "@gym/db";
import { and, desc, eq, ilike, inArray, isNull, lt, or } from "@gym/db/orm";
import { members } from "@gym/db/schema";
import { normalizePhone, type CountryCode } from "@gym/domain";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { z } from "zod";
import { compact } from "../common/compact";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { assertBranchesExist, assertWithinMyBranches } from "../tenancy/branch-checks";
import { canUseBranch, isBranchScoped, type TenantContext } from "../tenancy/tenant.guard";
import { DB, ENV } from "../tokens";

type MemberOut = z.output<typeof routes.getMember.response>;
type MemberIn = z.output<typeof routes.updateMember.body>;
type ListQuery = z.output<typeof routes.listMembers.query>;

const UNIQUE_VIOLATION = "23505";
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const toMember = (m: typeof members.$inferSelect): MemberOut => ({
  id: m.id,
  name: m.name,
  phone: m.phone,
  email: m.email,
  gender: m.gender,
  dateOfBirth: m.dateOfBirth,
  homeBranchId: m.homeBranchId,
  emergencyContactName: m.emergencyContactName,
  emergencyContactPhone: m.emergencyContactPhone,
  notes: m.notes,
  source: m.source,
  createdAt: m.createdAt.toISOString(),
});

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async list(tenant: TenantContext, query: ListQuery) {
    if (query.branchId && !canUseBranch(tenant, query.branchId))
      return { items: [], nextCursor: null };
    const term = query.q ? `%${escapeLike(query.q)}%` : undefined;
    const rows = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(members)
        .where(
          and(
            isNull(members.deletedAt),
            isBranchScoped(tenant) ? inArray(members.homeBranchId, tenant.branchIds) : undefined,
            query.branchId ? eq(members.homeBranchId, query.branchId) : undefined,
            term ? or(ilike(members.name, term), ilike(members.phone, term)) : undefined,
            query.after ? lt(members.id, query.after) : undefined,
          ),
        )
        .orderBy(desc(members.id))
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toMember),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(tenant: TenantContext, memberId: string): Promise<MemberOut> {
    return toMember(await this.find(tenant, memberId));
  }

  async create(
    tenant: TenantContext,
    body: MemberIn & { name: string; homeBranchId: string },
  ): Promise<MemberOut> {
    assertWithinMyBranches(
      tenant,
      [body.homeBranchId],
      "You can only add members to your own branches",
    );
    const values = this.normalise(body);
    return this.unique(() =>
      withTenant(this.db.db, tenant.tenantId, async (tx) => {
        await assertBranchesExist(tx, [body.homeBranchId]);
        const [row] = await tx
          .insert(members)
          .values({
            tenantId: tenant.tenantId,
            name: body.name,
            homeBranchId: body.homeBranchId,
            ...values,
          })
          .returning();
        if (!row) throw new Error("member insert returned nothing");
        await recordAudit(tx, {
          tenantId: tenant.tenantId,
          actorType: "staff",
          actorId: tenant.staffId,
          action: "member.created",
          entityType: "member",
          entityId: row.id,
        });
        return toMember(row);
      }),
    );
  }

  async update(tenant: TenantContext, memberId: string, body: MemberIn): Promise<MemberOut> {
    await this.find(tenant, memberId);
    if (body.homeBranchId)
      assertWithinMyBranches(
        tenant,
        [body.homeBranchId],
        "You can only move members to your own branches",
      );
    const values = this.normalise(body);
    return this.unique(() =>
      withTenant(this.db.db, tenant.tenantId, async (tx) => {
        if (body.homeBranchId) await assertBranchesExist(tx, [body.homeBranchId]);
        const [row] = await tx
          .update(members)
          .set(values)
          .where(eq(members.id, memberId))
          .returning();
        if (!row) throw new NotFoundException("Member not found");
        // Audit which fields changed, never their (personal) values.
        await recordAudit(tx, {
          tenantId: tenant.tenantId,
          actorType: "staff",
          actorId: tenant.staffId,
          action: "member.updated",
          entityType: "member",
          entityId: memberId,
          data: { fields: Object.keys(body) },
        });
        return toMember(row);
      }),
    );
  }

  /** A member outside the caller's branches does not exist for them. */
  async find(tenant: TenantContext, memberId: string) {
    const [row] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx
        .select()
        .from(members)
        .where(and(eq(members.id, memberId), isNull(members.deletedAt))),
    );
    if (!row || !canUseBranch(tenant, row.homeBranchId))
      throw new NotFoundException("Member not found");
    return row;
  }

  private normalise(body: MemberIn) {
    const phone = (raw: string | undefined, field: string) => {
      if (raw === undefined) return undefined;
      const e164 = normalizePhone(raw, this.env.DEFAULT_PHONE_REGION as CountryCode);
      if (!e164) throw new BadRequestException(`${field} is not a valid phone number`);
      return e164;
    };
    return compact({
      ...body,
      phone: phone(body.phone, "Phone"),
      emergencyContactPhone: phone(body.emergencyContactPhone, "Emergency contact phone"),
      email: body.email?.trim().toLowerCase(),
    });
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code =
        (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
      if (code === UNIQUE_VIOLATION)
        throw new ConflictException("A member with this phone number already exists");
      throw error;
    }
  }
}
