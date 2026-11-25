import { DEMO, seed, withTenant, type Database } from "@gym/db";
import { and, eq, isNull } from "@gym/db/orm";
import { kiosks } from "@gym/db/schema";
import { randomBytes } from "node:crypto";
import { hashToken } from "../common/crypto";

const KIOSK_NAME = "Synthetic check";

/**
 * Loads the demo gym (fixed ids, packages/db/src/seed.ts) and registers the kiosk the synthetic check scans
 * at, replacing an earlier one. Returns the new kiosk token, which is stored only as a hash. Never for
 * production (seed-demo.ts refuses).
 */
export async function loadDemo(db: Database): Promise<string> {
  await seed(db);
  const token = `kio.${DEMO.orgId}.${randomBytes(32).toString("base64url")}`;
  await withTenant(db, DEMO.orgId, async (tx) => {
    await tx
      .update(kiosks)
      .set({ revokedAt: new Date() })
      .where(and(eq(kiosks.name, KIOSK_NAME), isNull(kiosks.revokedAt)));
    await tx.insert(kiosks).values({
      tenantId: DEMO.orgId,
      branchId: DEMO.branchIds[0],
      name: KIOSK_NAME,
      tokenHash: hashToken(token),
      createdBy: DEMO.staff[0]?.id,
    });
  });
  return token;
}
