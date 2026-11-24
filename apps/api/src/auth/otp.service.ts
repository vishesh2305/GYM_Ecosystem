import type { DbHandle, Tx } from "@gym/db";
import { and, count, eq, gt, isNull, lt, sql } from "@gym/db/orm";
import { otpChallenges, users } from "@gym/db/schema";
import { normalizePhone, type CountryCode } from "@gym/domain";
import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { v7 } from "uuid";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import { DB, ENV, SMS_SENDER } from "../tokens";
import { userRegistered } from "./events";
import type { SmsSender } from "./senders";

export type OtpRequest = { channel: "sms"; phone: string };

const tooMany = (message: string) => new HttpException(message, 429);

/** One-time sign-in codes: 6 digits, HMAC-hashed, single use, limited attempts and limited sends. */
@Injectable()
export class OtpService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  async request(
    input: OtpRequest,
    ip: string,
  ): Promise<{ challengeId: string; expiresAt: string }> {
    const destination = normalizePhone(input.phone, this.env.DEFAULT_PHONE_REGION as CountryCode);
    if (!destination) throw new BadRequestException("Enter a valid mobile number");

    const since = new Date(Date.now() - this.env.OTP_WINDOW_SECONDS * 1000);
    const [recent] = await this.db.db
      .select({ n: count() })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.destination, destination), gt(otpChallenges.createdAt, since)));
    if ((recent?.n ?? 0) >= this.env.OTP_MAX_PER_WINDOW) {
      throw tooMany("Too many codes were requested for this number. Please try again later.");
    }

    const id = v7();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + this.env.OTP_TTL_SECONDS * 1000);
    await this.db.db.insert(otpChallenges).values({
      id,
      channel: input.channel,
      destination,
      codeHash: this.hash(id, code),
      expiresAt,
      ip,
    });

    const minutes = Math.max(1, Math.round(this.env.OTP_TTL_SECONDS / 60));
    try {
      await this.sms.send(
        destination,
        `${code} is your Gym Platform sign-in code. It expires in ${minutes} minutes. Never share it.`,
      );
    } catch {
      throw new ServiceUnavailableException(
        "We could not send the code right now. Please try again.",
      );
    }
    return { challengeId: id, expiresAt: expiresAt.toISOString() };
  }

  /** Checks the code and returns the user it signs in (creating the account on first sign-in). */
  async verify(
    challengeId: string,
    code: string,
    ip: string,
  ): Promise<{ userId: string; isNewUser: boolean }> {
    const max = this.env.OTP_MAX_ATTEMPTS;
    const [challenge] = await this.db.db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.id, challengeId));
    const expired = () =>
      new BadRequestException("This code has expired. Please request a new one.");
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now())
      throw expired();
    if (challenge.attempts >= max)
      throw tooMany("Too many wrong attempts. Please request a new code.");

    if (!this.matches(challenge.id, code, challenge.codeHash)) {
      const [after] = await this.db.db
        .update(otpChallenges)
        .set({ attempts: sql`${otpChallenges.attempts} + 1` })
        .where(eq(otpChallenges.id, challenge.id))
        .returning({ attempts: otpChallenges.attempts });
      const left = max - (after?.attempts ?? max);
      if (left <= 0) throw tooMany("Too many wrong attempts. Please request a new code.");
      throw new BadRequestException(`Incorrect code. ${left} attempts left.`);
    }

    // Claim the code atomically, so two parallel requests cannot both use it.
    const claimed = await this.db.db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(otpChallenges.id, challenge.id),
          isNull(otpChallenges.consumedAt),
          lt(otpChallenges.attempts, max),
        ),
      )
      .returning({ id: otpChallenges.id });
    if (!claimed.length) throw expired();

    return this.db.db.transaction(async (tx) => {
      const result = await this.findOrCreateByPhone(tx, challenge.destination);
      await recordAudit(tx, {
        actorType: "member",
        actorId: result.userId,
        action: "auth.signed_in",
        entityType: "user",
        entityId: result.userId,
        data: { method: challenge.channel },
        ip,
      });
      return result;
    });
  }

  private async findOrCreateByPhone(tx: Tx, phone: string) {
    const [created] = await tx
      .insert(users)
      .values({ phone, phoneVerifiedAt: new Date() })
      .onConflictDoNothing({ target: users.phone })
      .returning({ id: users.id });
    if (created) {
      await appendEvent(tx, userRegistered, { userId: created.id, via: "sms" }, null);
      return { userId: created.id, isNewUser: true };
    }
    const [existing] = await tx
      .update(users)
      .set({ phoneVerifiedAt: sql`coalesce(${users.phoneVerifiedAt}, now())` })
      .where(eq(users.phone, phone))
      .returning({ id: users.id });
    if (!existing) throw new Error("user vanished during sign-in");
    return { userId: existing.id, isNewUser: false };
  }

  private hash(challengeId: string, code: string): string {
    return createHmac("sha256", this.env.AUTH_SECRET)
      .update(`${challengeId}:${code}`)
      .digest("hex");
  }

  private matches(challengeId: string, code: string, expected: string): boolean {
    const actual = Buffer.from(this.hash(challengeId, code), "hex");
    const stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  }
}
