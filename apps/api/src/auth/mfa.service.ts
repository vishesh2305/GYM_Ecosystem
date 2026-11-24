import type { DbHandle } from "@gym/db";
import { and, count, eq, isNull, lt, or } from "@gym/db/orm";
import { recoveryCodes, userMfa, users } from "@gym/db/schema";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { createHmac, randomInt } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { decrypt, encrypt } from "../common/crypto";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { DB, ENV, REDIS } from "../tokens";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_SECONDS = 900;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
const failuresKey = (userId: string) => `auth:mfa-failures:${userId}`;

export type MfaProof = { code: string } | { recoveryCode: string };

/** Authenticator-app two-step verification with recovery codes, replay protection and a guess limit. */
@Injectable()
export class MfaService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async status(userId: string) {
    const [factor] = await this.db.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    const [left] = await this.db.db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
    return { totpEnabled: Boolean(factor?.confirmedAt), recoveryCodesLeft: left?.n ?? 0 };
  }

  /** Start (or restart) setup. Returns the secret for the authenticator app. */
  async setup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const [factor] = await this.db.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    if (factor?.confirmedAt) throw new ConflictException("Two-step verification is already on");
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    const secret = new Secret({ size: 20 });
    const sealed = encrypt(secret.base32, this.env.AUTH_ENCRYPTION_KEY);
    await this.db.db
      .insert(userMfa)
      .values({ userId, totpSecretEnc: sealed })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: { totpSecretEnc: sealed, lastUsedStep: null },
      });
    const totp = this.totp(secret.base32, user?.email ?? user?.phone ?? "account");
    return { secret: secret.base32, otpauthUrl: totp.toString() };
  }

  /** Finish setup with a first code; returns 10 recovery codes (shown once). */
  async confirm(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const [factor] = await this.db.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    if (!factor || factor.confirmedAt)
      throw new BadRequestException("Start two-step verification setup first");
    if (!(await this.acceptTotp(userId, factor.totpSecretEnc, code))) {
      throw new BadRequestException(
        "That code is not right. Check the time on your phone and try again.",
      );
    }
    const codes = Array.from({ length: 10 }, () => this.newRecoveryCode());
    await this.db.db.transaction(async (tx) => {
      await tx.update(userMfa).set({ confirmedAt: new Date() }).where(eq(userMfa.userId, userId));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx
        .insert(recoveryCodes)
        .values(codes.map((c) => ({ userId, codeHash: this.hashRecovery(c) })));
      await recordAudit(tx, {
        actorType: "member",
        actorId: userId,
        action: "auth.mfa_enabled",
        entityType: "user",
        entityId: userId,
      });
    });
    return { recoveryCodes: codes };
  }

  /** Check a code or recovery code. Five wrong answers in 15 minutes pause verification. */
  async verify(userId: string, proof: MfaProof): Promise<void> {
    const failures = Number(await this.redis.get(failuresKey(userId)).catch(this.unavailable));
    if (failures >= MAX_FAILURES)
      throw new HttpException("Too many wrong codes. Please wait 15 minutes.", 429);

    const [factor] = await this.db.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    if (!factor?.confirmedAt)
      throw new BadRequestException("Two-step verification is not turned on");

    const ok =
      "code" in proof
        ? await this.acceptTotp(userId, factor.totpSecretEnc, proof.code)
        : await this.useRecoveryCode(userId, proof.recoveryCode);
    if (!ok) {
      const count = await this.redis.incr(failuresKey(userId)).catch(this.unavailable);
      if (count === 1) await this.redis.expire(failuresKey(userId), FAILURE_WINDOW_SECONDS);
      throw new BadRequestException("That code is not right");
    }
    await this.redis.del(failuresKey(userId)).catch(this.unavailable);
  }

  async disable(userId: string): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx.delete(userMfa).where(eq(userMfa.userId, userId));
      await recordAudit(tx, {
        actorType: "member",
        actorId: userId,
        action: "auth.mfa_disabled",
        entityType: "user",
        entityId: userId,
      });
    });
  }

  /** Accepts the current, previous or next 30-second code, never one already used. */
  private async acceptTotp(userId: string, sealedSecret: string, code: string): Promise<boolean> {
    const delta = this.totp(decrypt(sealedSecret, this.env.AUTH_ENCRYPTION_KEY)).validate({
      token: code,
      window: 1,
    });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30_000) + delta;
    const claimed = await this.db.db
      .update(userMfa)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(userMfa.userId, userId),
          or(isNull(userMfa.lastUsedStep), lt(userMfa.lastUsedStep, step)),
        ),
      )
      .returning({ userId: userMfa.userId });
    return claimed.length > 0;
  }

  private async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const used = await this.db.db
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, this.hashRecovery(code)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .returning({ id: recoveryCodes.id });
    if (used.length) {
      await this.db.db.transaction((tx) =>
        recordAudit(tx, {
          actorType: "member",
          actorId: userId,
          action: "auth.recovery_code_used",
          entityType: "user",
          entityId: userId,
        }),
      );
    }
    return used.length > 0;
  }

  private totp(base32: string, label = "account"): TOTP {
    return new TOTP({ issuer: "Gym Platform", label, secret: Secret.fromBase32(base32) });
  }

  private newRecoveryCode(): string {
    const pick = () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    const part = () => Array.from({ length: 5 }, pick).join("");
    return `${part()}-${part()}`;
  }

  private hashRecovery(code: string): string {
    return createHmac("sha256", this.env.AUTH_SECRET)
      .update(code.toLowerCase().replace(/[\s-]/g, ""))
      .digest("hex");
  }

  /** The guess limit lives in Redis; without it, refuse rather than allow unlimited guesses. */
  private readonly unavailable = (): never => {
    throw new ServiceUnavailableException(
      "Two-step verification is temporarily unavailable. Please try again.",
    );
  };
}
