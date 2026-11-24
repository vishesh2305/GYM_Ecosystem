import {
  bigint,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, softDelete, timestamps } from "../columns";

const tz = { withTimezone: true } as const;

/** A person. Exists once across all gyms; gym membership comes later as a separate row. */
export const users = pgTable("users", {
  id: id(),
  /** E.164, e.g. +919812345678. */
  phone: text("phone").unique(),
  phoneVerifiedAt: timestamp("phone_verified_at", tz),
  /** Lower-cased. */
  email: text("email").unique(),
  emailVerifiedAt: timestamp("email_verified_at", tz),
  name: text("name"),
  ...timestamps,
  ...softDelete,
});

/** A signed-in device. Its id is the refresh-token family and the `sid` claim of access tokens. */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** How the user proved who they are, e.g. ["otp"], ["google"]; "mfa" is added after two-step verification. */
    amr: text("amr").array().notNull(),
    mfaVerifiedAt: timestamp("mfa_verified_at", tz),
    deviceName: text("device_name"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", tz).notNull().defaultNow(),
    /** Absolute end of the session, however often it is refreshed. */
    expiresAt: timestamp("expires_at", tz).notNull(),
    revokedAt: timestamp("revoked_at", tz),
    revokedReason: text("revoked_reason"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One row per issued refresh token; only the SHA-256 of the token is stored. */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    usedAt: timestamp("used_at", tz),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [index("refresh_tokens_session_idx").on(t.sessionId)],
);

/** A one-time sign-in code sent by SMS or email. Only an HMAC of the code is stored. */
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: id(),
    channel: text("channel", { enum: ["sms", "email"] }).notNull(),
    /** E.164 phone or lower-cased email. */
    destination: text("destination").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", tz).notNull(),
    consumedAt: timestamp("consumed_at", tz),
    ip: text("ip"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [index("otp_challenges_destination_idx").on(t.destination, t.createdAt)],
);

/** A Google or Apple account linked to a user. `subject` is the provider's stable user id. */
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google", "apple"] }).notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    unique("auth_identities_provider_subject").on(t.provider, t.subject),
    index("auth_identities_user_idx").on(t.userId),
  ],
);

/** Authenticator-app (TOTP) two-step verification. The secret is AES-256-GCM encrypted. */
export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  totpSecretEnc: text("totp_secret_enc").notNull(),
  confirmedAt: timestamp("confirmed_at", tz),
  /** Last accepted 30-second step: a code is never accepted twice. */
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

/** Single-use recovery codes for when the phone with the authenticator app is lost. Stored as HMACs. */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", tz),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);
