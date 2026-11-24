import type { routes } from "@gym/contracts";
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "../tenancy/tenant.guard";
import { MembershipsService, type MembershipOut } from "./memberships.service";

@TenantScoped()
@Controller("orgs/:orgId/members/:memberId/memberships")
export class MemberMembershipsController {
  constructor(@Inject(MembershipsService) private readonly service: MembershipsService) {}

  @Get()
  list(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.listMemberships.params)) params: { memberId: string },
  ): Promise<MembershipOut[]> {
    return this.service.list(tenant, params.memberId);
  }

  @Post()
  @Roles("owner", "manager", "front_desk")
  enrol(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.enrolMember.params)) params: { memberId: string },
    @Body(new ZodPipe(contracts.enrolMember.body)) body: z.output<typeof routes.enrolMember.body>,
  ): Promise<MembershipOut> {
    return this.service.enrol(tenant, params.memberId, body);
  }
}

@TenantScoped()
@Controller("orgs/:orgId/memberships/:membershipId")
export class MembershipActionsController {
  constructor(@Inject(MembershipsService) private readonly service: MembershipsService) {}

  @Post("freeze")
  @HttpCode(200)
  @Roles("owner", "manager", "front_desk")
  freeze(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.freezeMembership.params)) params: { membershipId: string },
    @Body(new ZodPipe(contracts.freezeMembership.body))
    body: z.output<typeof routes.freezeMembership.body>,
  ): Promise<MembershipOut> {
    return this.service.freeze(tenant, params.membershipId, body);
  }

  @Post("change-plan")
  @HttpCode(200)
  @Roles("owner", "manager", "front_desk")
  changePlan(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.changeMembershipPlan.params)) params: { membershipId: string },
    @Body(new ZodPipe(contracts.changeMembershipPlan.body)) body: { planId: string },
  ): Promise<z.output<typeof routes.changeMembershipPlan.response>> {
    return this.service.changePlan(tenant, params.membershipId, body.planId);
  }

  @Post("cancel")
  @HttpCode(200)
  @Roles("owner", "manager")
  cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.cancelMembership.params)) params: { membershipId: string },
    @Body(new ZodPipe(contracts.cancelMembership.body)) body: { reason: string },
  ): Promise<MembershipOut> {
    return this.service.cancel(tenant, params.membershipId, body.reason);
  }

  @Post("unfreeze")
  @HttpCode(200)
  @Roles("owner", "manager", "front_desk")
  unfreeze(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.unfreezeMembership.params)) params: { membershipId: string },
  ): Promise<MembershipOut> {
    return this.service.unfreeze(tenant, params.membershipId);
  }
}
