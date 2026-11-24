import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseEnvSchema, parseEnv } from "./env";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://gym:gym@localhost:5432/gym",
  REDIS_URL: "redis://localhost:6379",
};

describe("parseEnv", () => {
  it("returns typed values for a valid environment", () => {
    const env = parseEnv(baseEnvSchema, valid);
    expect(env.NODE_ENV).toBe("test");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("lists every invalid key and never echoes values", () => {
    const secret = "postgres://user:SUPERSECRET@host/db";
    const bad = {
      ...valid,
      DATABASE_URL: secret.replace("postgres", "mysql"),
      REDIS_URL: undefined,
    };
    let message = "";
    try {
      parseEnv(baseEnvSchema, bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("REDIS_URL");
    expect(message).not.toContain("SUPERSECRET");
  });

  it("can be extended per app", () => {
    const schema = baseEnvSchema.extend({ PORT: z.coerce.number().int().default(3000) });
    expect(parseEnv(schema, { ...valid, PORT: "8080" }).PORT).toBe(8080);
  });
});
