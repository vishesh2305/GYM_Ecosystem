import type { routes } from "@gym/contracts";
import { withUser, type Database, type DbHandle } from "@gym/db";
import { sql } from "@gym/db/orm";
import { Controller, Get, Inject, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { DB } from "../tokens";

export type MyGym = z.output<typeof routes.listMyGyms.response>[number];

/** The caller's member records across gyms, linking new ones by verified phone (see migration 0038). */
export async function myGyms(db: Database, userId: string): Promise<MyGym[]> {
  const result = await withUser(db, userId, (tx) =>
    tx.execute<{ tenant_id: string; org_name: string; member_id: string; member_name: string }>(
      sql`select * from app.my_gyms()`,
    ),
  );
  return result.rows.map((r) => ({
    orgId: r.tenant_id,
    orgName: r.org_name,
    memberId: r.member_id,
    memberName: r.member_name,
  }));
}

/** The caller's member record at one gym, or 404 when they are not a member there. */
export async function myMembership(db: Database, userId: string, orgId: string): Promise<MyGym> {
  const gym = (await myGyms(db, userId)).find((g) => g.orgId === orgId);
  if (!gym) throw new NotFoundException("You are not a member of this gym");
  return gym;
}

@Controller("me/gyms")
export class MyGymsController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<MyGym[]> {
    return myGyms(this.db.db, auth.userId);
  }
}
