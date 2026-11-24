import { parseEnv } from "@gym/config";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { inject } from "vitest";
import { apiEnvSchema, type ApiEnv } from "../src/env";

// Secrets are generated once per test file, so tokens stay valid across the apps a file creates.
const secrets = {
  JWT_PRIVATE_JWK: JSON.stringify(
    generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
  ),
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

/** The raw environment variables a test app starts with. */
export function rawTestEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    CORS_ORIGINS: "https://app.gym.test",
    ...secrets,
    ...overrides,
  };
}

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return parseEnv(apiEnvSchema, rawTestEnv(overrides));
}

/** A fresh client address, so per-address rate limits in one test do not affect another. */
export const randomIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
