import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { FeatureFlags } from "./feature-flags.service";
import { IdempotencyInterceptor } from "./idempotency";

@Global()
@Module({
  providers: [FeatureFlags, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
  exports: [FeatureFlags],
})
export class PlatformModule {}
