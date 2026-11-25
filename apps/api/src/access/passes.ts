import type { routes } from "@gym/contracts";
import { withTenant, type DbHandle, type Tx } from "@gym/db";
import { and, eq, lt } from "@gym/db/orm";
import { memberPasses } from "@gym/db/schema";
import { Controller, Get, Inject, Param } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import type { z } from "zod";
import { CurrentAuth } from "../auth/auth.guard";
import type { AuthContext } from "../auth/auth.types";
import { contracts } from "../common/contracts";
import { decrypt, encrypt } from "../common/crypto";
import { ZodPipe } from "../common/zod.pipe";
import type { ApiEnv } from "../env";
import { DB, ENV } from "../tokens";
import { myMembership } from "./my-gyms";

/** Codes change every 30 s; one step either side is accepted for phone and kiosk clocks that differ. */
export const PASS = { algorithm: "SHA1", digits: 8, period: 30, window: 1 } as const;
const QR = /^gp1\.([0-9a-f-]{36})\.(\d{8})$/;

export const qrPrefix = (memberId: string) => `gp1.${memberId}.`;

const totp = (base32: string) =>
  new TOTP({
    secret: Secret.fromBase32(base32),
    algorithm: PASS.algorithm,
    digits: PASS.digits,
    period: PASS.period,
  });

/** The member's pass secret (base32), created on first use. */
export async function ensurePass(
  tx: Tx,
  tenantId: string,
  memberId: string,
  key: Buffer,
): Promise<string> {
  await tx
    .insert(memberPasses)
    .values({ tenantId, memberId, secretEnc: encrypt(new Secret({ size: 20 }).base32, key) })
    .onConflictDoNothing();
  const [pass] = await tx.select().from(memberPasses).where(eq(memberPasses.memberId, memberId));
  if (!pass) throw new Error("member pass missing after insert");
  return decrypt(pass.secretEnc, key);
}

export type PassCheck =
  { ok: true; memberId: string } | { ok: false; reason: "invalid_code" | "code_already_used" };

/**
 * Check a scanned QR code inside the gym's tenant scope (so another gym's members are unknown). A valid code
 * is used up: only a newer time step than the last accepted one passes, even under concurrent scans.
 */
export async function checkPassCode(
  tx: Tx,
  qr: string,
  key: Buffer,
  now: Date = new Date(),
): Promise<PassCheck> {
  const [, memberId, code] = QR.exec(qr.trim()) ?? [];
  if (!memberId || !code) return { ok: false, reason: "invalid_code" };
  const [pass] = await tx.select().from(memberPasses).where(eq(memberPasses.memberId, memberId));
  if (!pass) return { ok: false, reason: "invalid_code" };
  const delta = totp(decrypt(pass.secretEnc, key)).validate({
    token: code,
    timestamp: now.getTime(),
    window: PASS.window,
  });
  if (delta === null) return { ok: false, reason: "invalid_code" };
  const counter = Math.floor(now.getTime() / 1000 / PASS.period) + delta;
  const used = await tx
    .update(memberPasses)
    .set({ lastCounter: counter })
    .where(and(eq(memberPasses.id, pass.id), lt(memberPasses.lastCounter, counter)))
    .returning({ id: memberPasses.id });
  return used.length ? { ok: true, memberId } : { ok: false, reason: "code_already_used" };
}

@Controller("me/gyms/:orgId/pass")
export class MyPassController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodPipe(contracts.getMyPass.params)) params: { orgId: string },
  ): Promise<z.output<typeof routes.getMyPass.response>> {
    const gym = await myMembership(this.db.db, auth.userId, params.orgId);
    const secret = await withTenant(this.db.db, gym.orgId, (tx) =>
      ensurePass(tx, gym.orgId, gym.memberId, this.env.AUTH_ENCRYPTION_KEY),
    );
    return {
      memberId: gym.memberId,
      secret,
      algorithm: PASS.algorithm,
      digits: PASS.digits,
      period: PASS.period,
      qrPrefix: qrPrefix(gym.memberId),
    };
  }
}
