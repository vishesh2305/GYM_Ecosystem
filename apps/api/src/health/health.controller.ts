import type { DbHandle } from "@gym/db";
import type { routes } from "@gym/contracts";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { z } from "zod";
import { Public } from "../auth/auth.guard";
import { DB, REDIS } from "../tokens";

type Out<R extends { response: z.ZodType }> = z.output<R["response"]>;

/** Resolves true if `probe` succeeds within `ms`, false otherwise. Never throws. */
async function check(probe: () => Promise<unknown>, ms = 1000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      probe().then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get("health")
  health(): Out<typeof routes.health> {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<Out<typeof routes.ready>> {
    const [database, cache] = await Promise.all([
      check(() => this.db.pool.query("select 1")),
      check(() => this.redis.ping()),
    ]);
    if (!database || !cache) {
      const failed = [!database && "database", !cache && "cache"].filter(Boolean).join(", ");
      throw new ServiceUnavailableException(`Not ready: ${failed}`);
    }
    return { status: "ok", checks: { database: "ok", cache: "ok" } };
  }
}
