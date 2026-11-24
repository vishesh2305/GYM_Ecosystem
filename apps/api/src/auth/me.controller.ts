import type { routes } from "@gym/contracts";
import type { DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { users } from "@gym/db/schema";
import { Body, Controller, Get, Inject, NotFoundException, Patch } from "@nestjs/common";
import type { z } from "zod";
import { contracts } from "../common/contracts";
import { ZodPipe } from "../common/zod.pipe";
import { DB } from "../tokens";
import { CurrentAuth } from "./auth.guard";
import type { AuthContext } from "./auth.types";

type Me = z.output<typeof routes.getMe.response>;

@Controller("me")
export class MeController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  async get(@CurrentAuth() auth: AuthContext): Promise<Me> {
    const [user] = await this.db.db.select().from(users).where(eq(users.id, auth.userId));
    if (!user) throw new NotFoundException("Account not found");
    return toMe(user);
  }

  @Patch()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(contracts.updateMe.body)) body: z.output<typeof routes.updateMe.body>,
  ): Promise<Me> {
    const [user] = await this.db.db
      .update(users)
      .set(body)
      .where(eq(users.id, auth.userId))
      .returning();
    if (!user) throw new NotFoundException("Account not found");
    return toMe(user);
  }
}

function toMe(user: typeof users.$inferSelect): Me {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}
