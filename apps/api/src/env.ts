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
    /** Which deployment this is; staging allows test sign-in numbers, production never does. */
    DEPLOY_ENV: z.enum(["local", "staging", "production"]).default("local"),
    /** Error reporting (Sentry). Unset: errors are only logged. Read by instrumentation.ts at start-up. */
    SENTRY_DSN: z.url().optional(),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /** Comma-separated list of allowed browser origins. Empty = no cross-origin access. */
    CORS_ORIGINS: csv,
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    TRUST_PROXY: z.stringbool().default(false),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** A read replica for owner reports. Unset: reports read the primary database. */
    DATABASE_READ_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
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
    /** "console" prints SMS to the log (development/tests); "msg91" sends DLT templates through MSG91. */
    SMS_PROVIDER: z.enum(["console", "msg91"]).default("console"),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_FLOW_URL: z.url().default("https://control.msg91.com/api/v5/flow"),
    /** JSON object: message key (otp, staff_invite, renewal_due, …) → MSG91 template id (DLT-approved). */
    MSG91_TEMPLATE_IDS: z
      .string()
      .default("{}")
      .transform((value) => JSON.parse(value) as unknown)
      .pipe(z.record(z.string(), z.string())),
    /** "console" logs push notifications (development/tests); "expo" sends through Expo (FCM and APNs). */
    PUSH_PROVIDER: z.enum(["console", "expo"]).default("console"),
    EXPO_PUSH_URL: z.url().default("https://exp.host/--/api/v2/push/send"),
    /** Only needed when "enhanced push security" is on in the Expo project. */
    EXPO_ACCESS_TOKEN: z.string().optional(),
    /** "cloud" sends approved templates through the WhatsApp Business Cloud API; "off" never uses WhatsApp. */
    WHATSAPP_PROVIDER: z.enum(["console", "cloud", "off"]).default("console"),
    WHATSAPP_API_URL: z.url().default("https://graph.facebook.com/v21.0"),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_TOKEN: z.string().optional(),
    /** How often the worker sends due member messages, and how many per gym each time (a per-gym throttle). */
    NOTIFY_POLL_MS: z.coerce.number().int().min(1000).default(30_000),
    NOTIFY_PER_GYM_PER_RUN: z.coerce.number().int().min(1).max(10_000).default(100),
    /** A message that fails on every channel is retried this many times, this many minutes apart. */
    NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    NOTIFY_RETRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
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
    /** Members with this many no-shows in 30 days cannot book in the app (staff still can). 0 = never. */
    NO_SHOW_LIMIT: z.coerce.number().int().min(0).max(20).default(0),
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
    for (const key of ["PUSH_PROVIDER", "WHATSAPP_PROVIDER"] as const) {
      if (env.NODE_ENV === "production" && env[key] === "console")
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "the console sender cannot be used in production",
        });
    }
    if (env.SMS_PROVIDER === "msg91" && !env.MSG91_AUTH_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["MSG91_AUTH_KEY"],
        message: "required when SMS_PROVIDER is msg91",
      });
    }
    if (
      env.WHATSAPP_PROVIDER === "cloud" &&
      (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_TOKEN)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["WHATSAPP_TOKEN"],
        message: "WhatsApp phone number id and token are required when WHATSAPP_PROVIDER is cloud",
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
