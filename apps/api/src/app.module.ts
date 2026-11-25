import { Module, type DynamicModule, type Type } from "@nestjs/common";
import type { Redis } from "ioredis";
import { AccessModule } from "./access/access.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { BillingModule } from "./billing/billing.module";
import { DocsController } from "./docs.controller";
import type { ApiEnv } from "./env";
import { HealthController } from "./health/health.controller";
import { CrmModule } from "./crm/crm.module";
import { InfraModule } from "./infra.module";
import { MembershipModule } from "./membership/membership.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PlatformModule } from "./platform/platform.module";
import { PrivacyModule } from "./privacy/privacy.module";
import { ReportsModule } from "./reports/reports.module";
import { SchedulingModule } from "./scheduling/scheduling.module";
import { TenancyModule } from "./tenancy/tenancy.module";
import { TrainingModule } from "./training/training.module";

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv, redis: Redis, modules: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(env, redis),
        PlatformModule,
        AuthModule,
        TenancyModule,
        MembershipModule,
        BillingModule,
        AccessModule,
        SchedulingModule,
        TrainingModule,
        NotificationsModule,
        CrmModule,
        ReportsModule,
        PrivacyModule,
        AdminModule,
        ...modules,
      ],
      controllers: [HealthController, DocsController],
    };
  }
}
