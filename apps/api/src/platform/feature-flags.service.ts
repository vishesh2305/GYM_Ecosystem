import type { DbHandle } from "@gym/db";
import { featureFlags } from "@gym/db/schema";
import { isFlagOn, type FlagRule, type FlagSubject } from "@gym/domain";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { DB, REDIS } from "../tokens";

const CACHE_KEY = "ff:v1:all";
const CACHE_SECONDS = 30;

/** Feature flags from Postgres, cached in Redis for 30 s. Unknown flags are off. */
@Injectable()
export class FeatureFlags {
  private readonly logger = new Logger(FeatureFlags.name);

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async isEnabled(key: string, subject: FlagSubject = {}): Promise<boolean> {
    const flag = (await this.load()).find((f) => f.key === key);
    return flag ? isFlagOn(flag, subject) : false;
  }

  /** Call after changing flags so every instance sees the change at once. */
  async invalidate(): Promise<void> {
    await this.redis.del(CACHE_KEY);
  }

  private async load(): Promise<FlagRule[]> {
    const cached = await this.redis.get(CACHE_KEY).catch((error: Error) => {
      this.logger.warn(`flag cache read failed: ${error.message}`);
      return null;
    });
    if (cached) return JSON.parse(cached) as FlagRule[];

    const rules: FlagRule[] = (await this.db.db.select().from(featureFlags)).map((f) => ({
      key: f.key,
      enabled: f.enabled,
      rolloutPercent: f.rolloutPercent,
      tenantIds: f.tenantIds,
      userIds: f.userIds,
    }));
    await this.redis
      .set(CACHE_KEY, JSON.stringify(rules), "EX", CACHE_SECONDS)
      .catch((error: Error) => {
        this.logger.warn(`flag cache write failed: ${error.message}`);
      });
    return rules;
  }
}
