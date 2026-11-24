import { parseEnv } from "@gym/config";
import { generateKeyPairSync } from "node:crypto";
import { inject } from "vitest";
import { apiEnvSchema, type ApiEnv } from "../src/env";

// One signing key per test file, so tokens stay valid across the apps a file creates.
const signingKey = JSON.stringify(
  generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
);

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return parseEnv(apiEnvSchema, {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    CORS_ORIGINS: "https://app.gym.test",
    JWT_PRIVATE_JWK: signingKey,
    ...overrides,
  });
}
