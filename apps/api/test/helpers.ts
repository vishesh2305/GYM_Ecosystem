import { parseEnv } from "@gym/config";
import { inject } from "vitest";
import { apiEnvSchema, type ApiEnv } from "../src/env";

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return parseEnv(apiEnvSchema, {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    CORS_ORIGINS: "https://app.gym.test",
    ...overrides,
  });
}
