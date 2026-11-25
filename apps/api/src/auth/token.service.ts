import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { calculateJwkThumbprint, importJWK, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { v7 } from "uuid";
import { z } from "zod";
import type { ApiEnv } from "../env";
import { ENV } from "../tokens";
import type { AuthContext } from "./auth.types";

const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid(), amr: z.array(z.string()) });

/** Signs and verifies short-lived access tokens (EdDSA / Ed25519). */
@Injectable()
export class TokenService {
  private readonly keys: Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; kid: string }>;
  private readonly publicJwk: Omit<ApiEnv["JWT_PRIVATE_JWK"], "d">;

  constructor(@Inject(ENV) private readonly env: ApiEnv) {
    const { d: _private, ...publicJwk } = env.JWT_PRIVATE_JWK;
    this.publicJwk = publicJwk;
    this.keys = Promise.all([
      importJWK(env.JWT_PRIVATE_JWK, "EdDSA") as Promise<CryptoKey>,
      importJWK(publicJwk, "EdDSA") as Promise<CryptoKey>,
      calculateJwkThumbprint(publicJwk),
    ]).then(([privateKey, publicKey, kid]) => ({ privateKey, publicKey, kid }));
  }

  get accessTtlSeconds(): number {
    return this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  /**
   * The public half of the signing key, so other services (the PowerSync sync service) can verify access
   * tokens themselves. Tokens carry this key's thumbprint as their "kid".
   */
  async jwks() {
    const { kid } = await this.keys;
    return {
      keys: [
        { kty: "OKP", crv: "Ed25519", x: this.publicJwk.x, kid, alg: "EdDSA", use: "sig" } as const,
      ],
    };
  }

  async issueAccess(auth: AuthContext): Promise<string> {
    const { privateKey, kid } = await this.keys;
    return new SignJWT({ sid: auth.sessionId, amr: auth.amr })
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setSubject(auth.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(this.env.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SECONDS}s`)
      .setJti(v7())
      .sign(privateKey);
  }

  /** Throws 401 for any token that is malformed, forged, expired or for another audience. */
  async verifyAccess(token: string): Promise<AuthContext> {
    const { publicKey } = await this.keys;
    try {
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        algorithms: ["EdDSA"],
      });
      const claims = claimsSchema.parse(payload);
      return { userId: claims.sub, sessionId: claims.sid, amr: claims.amr };
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }
}
