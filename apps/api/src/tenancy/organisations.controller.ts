import type { routes } from "@gym/contracts";
import { withTenant, withUser, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { branches, organisations, staffMembers } from "@gym/db/schema";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
} from "@nestjs/common";
import { v7 } from "uuid";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import { DB } from "../tokens";
import { organisationCreated } from "./events";
import { toBranch, toOrganisation, type OrganisationOut } from "./mappers";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "./tenant.guard";

type Body<K extends keyof typeof routes> = (typeof routes)[K] extends {
  body: infer B extends z.ZodType;
}
  ? z.output<B>
  : never;

@Controller("orgs")
export class OrganisationsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** Anyone signed in can register a gym; they become its owner. */
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.createOrganisation.body)) body: Body<"createOrganisation">,
  ): Promise<z.output<typeof routes.createOrganisation.response>> {
    const orgId = v7();
    return withTenant(this.db.db, orgId, async (tx) => {
      const [org] = await tx
        .insert(organisations)
        .values({
          id: orgId,
          name: body.name,
          gstin: body.gstin,
          timezone: body.timezone,
          createdBy: auth.userId,
        })
        .returning();
      const [branch] = await tx
        .insert(branches)
        .values({ tenantId: orgId, ...body.branch })
        .returning();
      await tx.insert(staffMembers).values({ tenantId: orgId, userId: auth.userId, role: "owner" });
      if (!org || !branch) throw new Error("organisation insert returned nothing");
      await appendEvent(
        tx,
        organisationCreated,
        { organisationId: orgId, ownerUserId: auth.userId },
        orgId,
      );
      await recordAudit(tx, {
        tenantId: orgId,
        actorType: "staff",
        actorId: auth.userId,
        action: "organisation.created",
        entityType: "organisation",
        entityId: orgId,
      });
      return { organisation: toOrganisation(org, "owner"), branch: toBranch(branch) };
    });
  }

  @Get()
  async mine(@CurrentAuth() auth: AuthContext): Promise<OrganisationOut[]> {
    return withUser(this.db.db, auth.userId, async (tx) => {
      const rows = await tx
        .select({ org: organisations, role: staffMembers.role })
        .from(staffMembers)
        .innerJoin(organisations, eq(organisations.id, staffMembers.tenantId))
        .where(eq(staffMembers.status, "active"));
      return rows.map((r) => toOrganisation(r.org, r.role));
    });
  }
}

@TenantScoped()
@Controller("orgs/:orgId")
export class OrganisationController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async get(@CurrentTenant() tenant: TenantContext): Promise<OrganisationOut> {
    const [org] = await withTenant(this.db.db, tenant.tenantId, (tx) =>
      tx.select().from(organisations),
    );
    if (!org) throw new NotFoundException("Organisation not found");
    return toOrganisation(org, tenant.role);
  }

  @Patch()
  @Roles("owner")
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.updateOrganisation.body)) body: Body<"updateOrganisation">,
  ): Promise<OrganisationOut> {
    return unique(() =>
      withTenant(this.db.db, tenant.tenantId, async (tx) => {
        const [current] = await tx
          .select({ slug: organisations.slug })
          .from(organisations)
          .where(eq(organisations.id, tenant.tenantId));
        if (body.published && !(body.slug ?? current?.slug))
          throw new BadRequestException("Choose a page address (slug) before publishing");
        const [org] = await tx
          .update(organisations)
          .set(body)
          .where(eq(organisations.id, tenant.tenantId))
          .returning();
        if (!org) throw new NotFoundException("Organisation not found");
        await recordAudit(tx, {
          tenantId: tenant.tenantId,
          actorType: "staff",
          actorId: tenant.staffId,
          action: "organisation.updated",
          entityType: "organisation",
          entityId: org.id,
          data: body,
        });
        return toOrganisation(org, tenant.role);
      }),
    );
  }
}

/** A slug another gym already uses is a 409. */
async function unique<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code =
      (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code === "23505") throw new ConflictException("Another gym already uses this page address");
    throw error;
  }
}
