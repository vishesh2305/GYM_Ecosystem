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
import { DB, ENV, READ_DB, REDIS } from "./tokens";

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
    @Inject(READ_DB) private readonly readDb: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.db.pool.end();
    if (this.readDb !== this.db) await this.readDb.pool.end();
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
        {
          provide: READ_DB,
          inject: [DB],
          useFactory: (db: DbHandle) =>
            env.DATABASE_READ_URL ? createDb(env.DATABASE_READ_URL, env.DB_POOL_MAX) : db,
        },
        { provide: REDIS, useValue: redis },
        InfraShutdown,
      ],
      exports: [ENV, DB, READ_DB, REDIS],
    };
  }
}
