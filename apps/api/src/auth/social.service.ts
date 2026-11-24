import type { DbHandle } from "@gym/db";
import { and, eq, isNotNull } from "@gym/db/orm";
import { authIdentities, users } from "@gym/db/schema";
import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { appendEvent } from "../platform/events";
import { DB, ENV } from "../tokens";
import { userRegistered } from "./events";

export type Provider = "google" | "apple";
const LABEL: Record<Provider, string> = { google: "Google", apple: "Apple" };

const idTokenClaims = z.object({
  sub: z.string().min(1),
  nonce: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  name: z.string().optional(),
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface SocialSignIn {
  idToken: string;
  /** The raw nonce the app generated for this sign-in (Apple receives its SHA-256, Google the raw value). */
  nonce: string;
  /** Apple sends the person's name to the app only on the first sign-in. */
  name?: string | undefined;
}

/**
 * Verifies Google / Apple ID tokens against the provider's public keys and links them to a user:
 * known identity → its user; else a user who already proved the same email → link; else a new user.
 * Unverified emails are never used for linking or stored.
 */
@Injectable()
export class SocialSignInService {
  private readonly keySets = new Map<Provider, JWTVerifyGetKey>();

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async signIn(
    provider: Provider,
    input: SocialSignIn,
    ip: string,
  ): Promise<{ userId: string; isNewUser: boolean }> {
    const config =
      provider === "google"
        ? {
            clientIds: this.env.GOOGLE_CLIENT_IDS,
            jwks: this.env.GOOGLE_JWKS_URL,
            issuers: this.env.GOOGLE_ISSUERS,
          }
        : {
            clientIds: this.env.APPLE_CLIENT_IDS,
            jwks: this.env.APPLE_JWKS_URL,
            issuers: this.env.APPLE_ISSUERS,
          };
    if (!config.clientIds.length)
      throw new BadRequestException(`Sign-in with ${LABEL[provider]} is not available`);

    const rejected = () =>
      new UnauthorizedException(`This ${LABEL[provider]} sign-in could not be verified`);
    let claims: z.output<typeof idTokenClaims>;
    try {
      const { payload } = await jwtVerify(input.idToken, this.keySet(provider, config.jwks), {
        issuer: config.issuers,
        audience: config.clientIds,
        algorithms: ["RS256"],
      });
      claims = idTokenClaims.parse(payload);
    } catch {
      throw rejected();
    }
    // The nonce ties the token to this sign-in attempt, so a captured token cannot be replayed.
    if (claims.nonce !== (provider === "apple" ? sha256(input.nonce) : input.nonce))
      throw rejected();

    const verified = claims.email_verified === true || claims.email_verified === "true";
    const email = verified && claims.email ? claims.email.trim().toLowerCase() : null;

    return this.db.db.transaction(async (tx) => {
      const audit = (userId: string) =>
        recordAudit(tx, {
          actorType: "member",
          actorId: userId,
          action: "auth.signed_in",
          entityType: "user",
          entityId: userId,
          data: { method: provider },
          ip,
        });

      const [identity] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, claims.sub)));
      if (identity) {
        await audit(identity.userId);
        return { userId: identity.userId, isNewUser: false };
      }

      const [byEmail] = email
        ? await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.email, email), isNotNull(users.emailVerifiedAt)))
        : [];
      let userId = byEmail?.id;
      const isNewUser = !userId;
      if (!userId) {
        const name = input.name ?? claims.name ?? null;
        // If the email belongs to someone who never proved it, do not claim it: create the account without email.
        const [created] = email
          ? await tx
              .insert(users)
              .values({ email, emailVerifiedAt: new Date(), name })
              .onConflictDoNothing()
              .returning()
          : [];
        userId = created?.id ?? (await tx.insert(users).values({ name }).returning())[0]?.id;
        if (!userId) throw new Error("user insert returned nothing");
        await appendEvent(tx, userRegistered, { userId, via: provider }, null);
      }
      await tx.insert(authIdentities).values({ userId, provider, subject: claims.sub, email });
      await audit(userId);
      return { userId, isNewUser };
    });
  }

  private keySet(provider: Provider, url: string): JWTVerifyGetKey {
    let set = this.keySets.get(provider);
    if (!set) {
      set = createRemoteJWKSet(new URL(url));
      this.keySets.set(provider, set);
    }
    return set;
  }
}
