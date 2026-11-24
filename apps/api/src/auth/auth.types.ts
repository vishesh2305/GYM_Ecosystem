/** Who is calling, attached to the request by AuthGuard. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** Authentication methods, e.g. ["otp"] or ["otp", "mfa"]. */
  amr: string[];
}

export interface TokenPair {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
