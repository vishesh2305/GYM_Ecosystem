import type { Tx } from "@gym/db";
import { and, count, inArray, isNull } from "@gym/db/orm";
import { branches } from "@gym/db/schema";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { isBranchScoped, type TenantContext } from "./tenant.guard";

/** Every id must be a branch of this organisation (RLS hides other gyms' branches). */
export async function assertBranchesExist(tx: Tx, branchIds: readonly string[]): Promise<void> {
  const unique = [...new Set(branchIds)];
  if (!unique.length) return;
  const [found] = await tx
    .select({ n: count() })
    .from(branches)
    .where(and(inArray(branches.id, unique), isNull(branches.deletedAt)));
  if ((found?.n ?? 0) !== unique.length)
    throw new BadRequestException("One or more branches do not exist");
}

/** Branch-scoped staff may only hand out access to their own branches ("all branches" is wider). */
export function assertWithinMyBranches(
  tenant: TenantContext,
  branchIds: readonly string[],
  message: string,
): void {
  if (!isBranchScoped(tenant)) return;
  if (!branchIds.length || branchIds.some((id) => !tenant.branchIds.includes(id)))
    throw new ForbiddenException(message);
}

/** Does a record limited to `branchIds` (empty = all) concern any branch the caller works at? */
export const overlapsMyBranches = (tenant: TenantContext, branchIds: readonly string[]) =>
  !isBranchScoped(tenant) ||
  !branchIds.length ||
  branchIds.some((id) => tenant.branchIds.includes(id));
