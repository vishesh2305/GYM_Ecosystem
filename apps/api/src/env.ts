import { baseEnvSchema } from "@gym/config";
import { z } from "zod";

export const apiEnvSchema = baseEnvSchema.extend({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /** Comma-separated list of allowed browser origins. Empty = no cross-origin access. */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  TRUST_PROXY: z.stringbool().default(false),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

export type ApiEnv = z.output<typeof apiEnvSchema>;
