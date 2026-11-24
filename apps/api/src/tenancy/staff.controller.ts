import type { routes } from "@gym/contracts";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import type { OrganisationOut } from "./mappers";
import { StaffService } from "./staff.service";
import { CurrentTenant, Roles, TenantScoped, type TenantContext } from "./tenant.guard";

type Out<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

@TenantScoped()
@Controller("orgs/:orgId")
export class StaffController {
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @Post("invites")
  @Roles("owner", "manager")
  invite(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(contracts.inviteStaff.body)) body: z.output<typeof routes.inviteStaff.body>,
  ): Promise<Out<"inviteStaff">> {
    return this.staff.invite(tenant, body);
  }

  @Get("invites")
  @Roles("owner", "manager")
  invites(@CurrentTenant() tenant: TenantContext): Promise<Out<"listInvites">> {
    return this.staff.pendingInvites(tenant);
  }

  @Delete("invites/:inviteId")
  @HttpCode(204)
  @Roles("owner", "manager")
  async revoke(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.revokeInvite.params)) params: { inviteId: string },
  ): Promise<void> {
    await this.staff.revokeInvite(tenant, params.inviteId);
  }

  @Get("staff")
  @Roles("owner", "manager")
  list(@CurrentTenant() tenant: TenantContext): Promise<Out<"listStaff">> {
    return this.staff.list(tenant);
  }

  @Patch("staff/:staffId")
  @Roles("owner")
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.updateStaff.params)) params: { staffId: string },
    @Body(new ZodPipe(contracts.updateStaff.body)) body: z.output<typeof routes.updateStaff.body>,
  ): Promise<Out<"updateStaff">> {
    return this.staff.update(tenant, params.staffId, body);
  }

  @Delete("staff/:staffId")
  @HttpCode(204)
  @Roles("owner")
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param(new ZodPipe(contracts.removeStaff.params)) params: { staffId: string },
  ): Promise<void> {
    await this.staff.remove(tenant, params.staffId);
  }
}

@Controller("invites")
export class InvitesController {
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @Post("accept")
  @HttpCode(200)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.acceptInvite.body)) body: { token: string },
  ): Promise<OrganisationOut> {
    return this.staff.accept(auth.userId, body.token);
  }
}
