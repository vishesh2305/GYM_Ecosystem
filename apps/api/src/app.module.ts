import { Module, type DynamicModule, type Type } from "@nestjs/common";
import type { Redis } from "ioredis";
import { AuthModule } from "./auth/auth.module";
import { DocsController } from "./docs.controller";
import type { ApiEnv } from "./env";
import { HealthController } from "./health/health.controller";
import { InfraModule } from "./infra.module";
import { PlatformModule } from "./platform/platform.module";
import { TenancyModule } from "./tenancy/tenancy.module";

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
        ...modules,
      ],
      controllers: [HealthController, DocsController],
    };
  }
}
