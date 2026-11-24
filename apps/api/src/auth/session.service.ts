import type { DbHandle } from "@gym/db";
import { and, desc, eq, gt, isNull } from "@gym/db/orm";
import { refreshTokens, sessions } from "@gym/db/schema";
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import type { ApiEnv } from "../env";
import { recordAudit } from "../platform/audit";
import { DB, ENV, REDIS } from "../tokens";
import type { TokenPair } from "./auth.types";
import { TokenService } from "./token.service";

const DAY = 86_400_000;
const revokedKey = (sessionId: string) => `auth:revoked:${sessionId}`;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SessionStart {
  amr: string[];
  deviceName?: string | undefined;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/**
 * Sessions = signed-in devices. Refresh tokens rotate on every use; presenting a used refresh token
 * (a sign of theft) ends the whole session. Revocation is pushed to Redis so access tokens stop at once.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  async createSession(userId: string, start: SessionStart): Promise<TokenPair> {
    const [session] = await this.db.db
      .insert(sessions)
      .values({
        userId,
        amr: start.amr,
        deviceName: start.deviceName,
        userAgent: start.userAgent,
        ip: start.ip,
        expiresAt: new Date(Date.now() + this.env.SESSION_MAX_DAYS * DAY),
      })
      .returning();
    if (!session) throw new Error("session insert returned nothing");
    return this.issue(session.id, userId, session.amr);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const invalid = () => new UnauthorizedException("Invalid or expired refresh token");
    const [row] = await this.db.db
      .select({ token: refreshTokens, session: sessions })
      .from(refreshTokens)
      .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
      .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
    if (!row || row.session.revokedAt) throw invalid();

    // Atomically claim the token; if it was already used, someone else holds a copy.
    const claimed = await this.db.db
      .update(refreshTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(refreshTokens.id, row.token.id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    if (!claimed.length) {
      await this.revoke(row.session.id, "refresh_token_reuse");
      await this.db.db.transaction((tx) =>
        recordAudit(tx, {
          actorType: "system",
          actorId: row.session.userId,
          action: "auth.refresh_token_reused",
          entityType: "session",
          entityId: row.session.id,
        }),
      );
      this.logger.warn(`refresh token reuse; session ${row.session.id} revoked`);
      throw invalid();
    }
    const now = Date.now();
    if (row.token.expiresAt.getTime() <= now || row.session.expiresAt.getTime() <= now)
      throw invalid();

    await this.db.db
      .update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.id, row.session.id));
    return this.issue(row.session.id, row.session.userId, row.session.amr);
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.db.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    await this.redis
      .set(revokedKey(sessionId), reason, "EX", this.env.ACCESS_TOKEN_TTL_SECONDS)
      .catch((error: Error) => this.logger.warn(`revocation cache write failed: ${error.message}`));
  }

  async revokeAll(userId: string, reason: string): Promise<void> {
    for (const session of await this.active(userId)) await this.revoke(session.id, reason);
  }

  /** Revoke one of the user's own sessions; another user's session looks like it does not exist. */
  async revokeOwn(userId: string, sessionId: string): Promise<void> {
    if (!(await this.active(userId)).some((s) => s.id === sessionId))
      throw new NotFoundException("Session not found");
    await this.revoke(sessionId, "signed_out_remotely");
  }

  active(userId: string) {
    return this.db.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(sessions.lastUsedAt));
  }

  /** Redis first (fast); falls back to the database if Redis is unavailable, so revocation always holds. */
  async isRevoked(sessionId: string): Promise<boolean> {
    try {
      if (await this.redis.exists(revokedKey(sessionId))) return true;
    } catch {
      const [session] = await this.db.db
        .select({ revokedAt: sessions.revokedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return !session || session.revokedAt !== null;
    }
    return false;
  }

  private async issue(sessionId: string, userId: string, amr: string[]): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString("base64url");
    await this.db.db.insert(refreshTokens).values({
      sessionId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * DAY),
    });
    return {
      sessionId,
      accessToken: await this.tokens.issueAccess({ userId, sessionId, amr }),
      refreshToken,
      tokenType: "Bearer",
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }
}
