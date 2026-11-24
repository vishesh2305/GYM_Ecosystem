import { createDb, type DbHandle } from "@gym/db";
import {
  Global,
  Inject,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Redis } from "ioredis";
import type { ApiEnv } from "./env";
import { DB, ENV, REDIS } from "./tokens";

export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  const logger = new Logger("Redis");
  // Connection errors surface through /v1/ready; log them instead of crashing the process.
  redis.on("error", (error: Error) => logger.warn(error.message));
  return redis;
}

class InfraShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.db.pool.end();
  }
}

@Global()
@Module({})
export class InfraModule {
  static forRoot(env: ApiEnv, redis: Redis): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: ENV, useValue: env },
        { provide: DB, useFactory: () => createDb(env.DATABASE_URL, env.DB_POOL_MAX) },
        { provide: REDIS, useValue: redis },
        InfraShutdown,
      ],
      exports: [ENV, DB, REDIS],
    };
  }
}
