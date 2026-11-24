import type { routes } from "@gym/contracts";
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { MembersService } from "./members.service";

type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

@TenantScoped()
@Controller("orgs/:orgId/members")
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @Get()
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(contracts.listMembers.query))
    query: z.output<typeof routes.listMembers.query>,
  ): Promise<Out<"listMembers">> {
    return this.members.list(tenant, query);
  }

  @Post()
  @Roles("owner", "manager", "front_desk")
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.createMember.body)) body: z.output<typeof routes.createMember.body>,
  ): Promise<Out<"createMember">> {
    return this.members.create(tenant, body);
  }

  @Get(":memberId")
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.getMember.params)) params: { memberId: string },
  ): Promise<Out<"getMember">> {
    return this.members.get(tenant, params.memberId);
  }

  @Patch(":memberId")
  @Roles("owner", "manager", "front_desk")
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.updateMember.params)) params: { memberId: string },
    @Body(new ZodPipe(contracts.updateMember.body)) body: z.output<typeof routes.updateMember.body>,
  ): Promise<Out<"updateMember">> {
    return this.members.update(tenant, params.memberId, body);
  }
}
