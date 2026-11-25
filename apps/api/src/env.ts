import { baseEnvSchema } from "@gym/config";
import { z } from "zod";

/** Ed25519 private key as a JWK JSON string (`pnpm --filter @gym/api keys` prints one). */
const ed25519Jwk = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON Web Key" });
      return z.NEVER;
    }
  })
  .pipe(
    z.object(
      { kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string(), d: z.string() },
      { error: "must be an Ed25519 private JWK" },
    ),
  );

/** Comma-separated list → array of trimmed, non-empty strings. */
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );

export const apiEnvSchema = baseEnvSchema
  .extend({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /** Comma-separated list of allowed browser origins. Empty = no cross-origin access. */
    CORS_ORIGINS: csv,
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    TRUST_PROXY: z.stringbool().default(false),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
    OUTBOX_BATCH: z.coerce.number().int().positive().max(1000).default(100),
    EVENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    EVENT_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
    /** Redis key prefix for background queues (lets several environments share one Redis). */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .default("bull"),
    JWT_PRIVATE_JWK: ed25519Jwk,
    JWT_ISSUER: z.string().default("gym-platform"),
    JWT_AUDIENCE: z.string().default("gym-api"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(0).default(30),
    SESSION_MAX_DAYS: z.coerce.number().int().positive().default(90),
    /** Secret for hashing one-time codes (at least 32 characters). */
    AUTH_SECRET: z.string().min(32),
    /** 32 random bytes, base64. Encrypts two-step verification secrets. `openssl rand -base64 32` */
    AUTH_ENCRYPTION_KEY: z
      .base64()
      .transform((value) => Buffer.from(value, "base64"))
      .refine((key) => key.length === 32, "must be 32 bytes (base64)"),
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_MAX_PER_WINDOW: z.coerce.number().int().positive().default(3),
    OTP_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
    DEFAULT_PHONE_REGION: z.string().length(2).default("IN"),
    /** "console" prints codes to the log: development and tests only. Real providers arrive in step A14. */
    SMS_PROVIDER: z.enum(["console"]).default("console"),
    /** "console" prints emails to the log (development/tests); "smtp" sends through SMTP_URL. */
    EMAIL_PROVIDER: z.enum(["console", "smtp"]).default("console"),
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    EMAIL_FROM: z.string().default("Gym Platform <no-reply@localhost>"),
    /** Public address of the web app; used in links sent to people (e.g. staff invites). */
    APP_URL: z.url().default("http://localhost:3001"),
    /** "fake" creates pretend orders (development/tests); "razorpay" uses the real gateway. */
    PAYMENT_GATEWAY: z.enum(["fake", "razorpay"]).default("fake"),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /** Secret shared with Razorpay for webhook signatures (also used by the fake gateway). */
    RAZORPAY_WEBHOOK_SECRET: z.string().min(8).default("dev-webhook-secret"),
    /** Days after an invoice's due date before the unpaid membership expires. */
    DUNNING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
    /** Hours after check-in when a member who never checked out no longer counts as inside. */
    CHECKIN_AUTO_OUT_HOURS: z.coerce.number().int().min(1).max(24).default(3),
    /** Owners, managers and front desk must pass two-step verification before using a gym's data. */
    STAFF_MFA_REQUIRED: z.stringbool().default(true),
    /** OAuth client ids allowed as token audience (web, Android, iOS). Empty = sign-in with Google is off. */
    GOOGLE_CLIENT_IDS: csv,
    GOOGLE_JWKS_URL: z.url().default("https://www.googleapis.com/oauth2/v3/certs"),
    GOOGLE_ISSUERS: csv.default(["https://accounts.google.com", "accounts.google.com"]),
    /** App bundle id / Services id. Empty = sign-in with Apple is off. */
    APPLE_CLIENT_IDS: csv,
    APPLE_JWKS_URL: z.url().default("https://appleid.apple.com/auth/keys"),
    APPLE_ISSUERS: csv.default(["https://appleid.apple.com"]),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.SMS_PROVIDER === "console") {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER"],
        message: "the console sender cannot be used in production",
      });
    }
    if (env.NODE_ENV === "production" && env.EMAIL_PROVIDER === "console") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER"],
        message: "the console sender cannot be used in production",
      });
    }
    if (env.NODE_ENV === "production" && env.PAYMENT_GATEWAY === "fake") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_GATEWAY"],
        message: "the fake gateway cannot be used in production",
      });
    }
    if (env.PAYMENT_GATEWAY === "razorpay" && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["RAZORPAY_KEY_ID"],
        message: "Razorpay key id and secret are required",
      });
    }
    if (env.NODE_ENV === "production" && env.RAZORPAY_WEBHOOK_SECRET === "dev-webhook-secret") {
      ctx.addIssue({
        code: "custom",
        path: ["RAZORPAY_WEBHOOK_SECRET"],
        message: "set the real webhook secret",
      });
    }
    if (env.EMAIL_PROVIDER === "smtp" && !env.SMTP_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_URL"],
        message: "required when EMAIL_PROVIDER is smtp",
      });
    }
  });

export type ApiEnv = z.output<typeof apiEnvSchema>;
