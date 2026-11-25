import { z } from "zod";
import { defineRoute } from "../route";

export const tokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
});

export const getJwks = defineRoute({
  method: "GET",
  path: "/v1/auth/jwks",
  summary:
    "Public keys that sign access tokens (JWKS), for services such as PowerSync that verify tokens themselves",
  tag: "auth",
  response: z.object({
    keys: z.array(
      z.object({
        kty: z.literal("OKP"),
        crv: z.literal("Ed25519"),
        x: z.string(),
        kid: z.string(),
        alg: z.literal("EdDSA"),
        use: z.literal("sig"),
      }),
    ),
  }),
});

export const refreshSession = defineRoute({
  method: "POST",
  path: "/v1/auth/refresh",
  summary: "Exchange a refresh token for a new token pair (the old refresh token stops working)",
  tag: "auth",
  body: z.object({ refreshToken: z.string().min(1).max(200) }),
  response: tokenPair,
});

export const signOut = defineRoute({
  method: "POST",
  path: "/v1/auth/logout",
  summary: "Sign out this device",
  tag: "auth",
  response: z.undefined(),
  status: 204,
});

export const signOutEverywhere = defineRoute({
  method: "POST",
  path: "/v1/auth/logout-all",
  summary: "Sign out every device",
  tag: "auth",
  response: z.undefined(),
  status: 204,
});

export const listSessions = defineRoute({
  method: "GET",
  path: "/v1/auth/sessions",
  summary: "Devices that are signed in to my account",
  tag: "auth",
  response: z.array(
    z.object({
      id: z.uuid(),
      deviceName: z.string().nullable(),
      userAgent: z.string().nullable(),
      ip: z.string().nullable(),
      createdAt: z.iso.datetime(),
      lastUsedAt: z.iso.datetime(),
      current: z.boolean(),
    }),
  ),
});

export const revokeSession = defineRoute({
  method: "DELETE",
  path: "/v1/auth/sessions/{sessionId}",
  summary: "Sign out one of my devices",
  tag: "auth",
  params: z.object({ sessionId: z.uuid() }),
  response: z.undefined(),
  status: 204,
});

export const requestOtp = defineRoute({
  method: "POST",
  path: "/v1/auth/otp/request",
  summary: "Send a one-time sign-in code by SMS or email",
  tag: "auth",
  body: z.discriminatedUnion("channel", [
    z.object({ channel: z.literal("sms"), phone: z.string().trim().min(3).max(32) }),
    z.object({ channel: z.literal("email"), email: z.email().max(254) }),
  ]),
  response: z.object({ challengeId: z.uuid(), expiresAt: z.iso.datetime() }),
  status: 202,
});

export const verifyOtp = defineRoute({
  method: "POST",
  path: "/v1/auth/otp/verify",
  summary: "Sign in with the one-time code (creates the account on first sign-in)",
  tag: "auth",
  body: z.object({
    challengeId: z.uuid(),
    code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
    deviceName: z.string().trim().max(100).optional(),
  }),
  response: tokenPair.extend({ isNewUser: z.boolean() }),
});

export const signInWithProvider = defineRoute({
  method: "POST",
  path: "/v1/auth/social/{provider}",
  summary: "Sign in with a Google or Apple ID token (creates or links the account)",
  tag: "auth",
  params: z.object({ provider: z.enum(["google", "apple"]) }),
  body: z.object({
    idToken: z.string().min(1).max(4096),
    nonce: z.string().min(8).max(128),
    name: z.string().trim().min(1).max(100).optional(),
    deviceName: z.string().trim().max(100).optional(),
  }),
  response: tokenPair.extend({ isNewUser: z.boolean() }),
});

export const getMfaStatus = defineRoute({
  method: "GET",
  path: "/v1/auth/mfa",
  summary: "Is two-step verification on, and how many recovery codes are left",
  tag: "auth",
  response: z.object({ totpEnabled: z.boolean(), recoveryCodesLeft: z.number().int() }),
});

export const setupTotp = defineRoute({
  method: "POST",
  path: "/v1/auth/mfa/totp/setup",
  summary: "Start two-step verification: returns the secret / QR link for an authenticator app",
  tag: "auth",
  response: z.object({ secret: z.string(), otpauthUrl: z.string() }),
  status: 201,
});

export const confirmTotp = defineRoute({
  method: "POST",
  path: "/v1/auth/mfa/totp/confirm",
  summary: "Finish setup with a first code; returns 10 one-time recovery codes (shown once)",
  tag: "auth",
  body: z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }),
  response: z.object({ recoveryCodes: z.array(z.string()) }),
});

export const verifyMfa = defineRoute({
  method: "POST",
  path: "/v1/auth/mfa/verify",
  summary:
    "Prove two-step verification for this session (code or recovery code); returns upgraded tokens",
  tag: "auth",
  body: z.union([
    z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }),
    z.object({ recoveryCode: z.string().min(10).max(20) }),
  ]),
  response: tokenPair,
});

export const disableTotp = defineRoute({
  method: "DELETE",
  path: "/v1/auth/mfa/totp",
  summary: "Turn off two-step verification (requires a verified session)",
  tag: "auth",
  response: z.undefined(),
  status: 204,
});
