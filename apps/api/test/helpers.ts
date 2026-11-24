import { parseEnv } from "@gym/config";
import type { Database } from "@gym/db";
import { users } from "@gym/db/schema";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { inject } from "vitest";
import { SessionService } from "../src/auth/session.service";
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

/** Create a user and a signed-in session for them. `amr` defaults to an SMS-code sign-in. */
export async function signedInUser(
  app: { get<T>(token: abstract new (...args: never[]) => T): T },
  db: Database,
  options: { name?: string; amr?: string[]; phone?: string; email?: string } = {},
) {
  const verified = new Date();
  const [user] = await db
    .insert(users)
    .values({
      name: options.name ?? "Test person",
      ...(options.phone && { phone: options.phone, phoneVerifiedAt: verified }),
      ...(options.email && { email: options.email, emailVerifiedAt: verified }),
    })
    .returning();
  if (!user) throw new Error("user insert returned nothing");
  const tokens = await app
    .get(SessionService)
    .createSession(user.id, { amr: options.amr ?? ["otp"] });
  return { user, ...tokens, headers: { authorization: `Bearer ${tokens.accessToken}` } };
}

/** A signed-in person whose session has passed two-step verification, as staff need. */
export const signedInStaff = (...[app, db, options = {}]: Parameters<typeof signedInUser>) =>
  signedInUser(app, db, { ...options, amr: ["otp", "mfa"] });

type Injectable = {
  inject(opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: object;
  }): Promise<{
    json(): any; // eslint-disable-line @typescript-eslint/no-explicit-any
    statusCode: number;
  }>;
};

/** A gym with one branch, an owner (with two-step verification), one member and plan/sign-up shortcuts. */
export async function gymWithMember(
  app: Parameters<typeof signedInUser>[0] & Injectable,
  db: Database,
) {
  const owner = await signedInStaff(app, db);
  const call = (method: string, url: string, payload?: object) =>
    app.inject({ method, url, headers: owner.headers, ...(payload && { payload }) });
  const created = (
    await call("POST", "/v1/orgs", { name: "Test Gym", branch: { name: "Main", city: "Pune" } })
  ).json();
  const base = `/v1/orgs/${created.organisation.id}`;
  const member = (
    await call("POST", `${base}/members`, { name: "Member", homeBranchId: created.branch.id })
  ).json();
  return {
    owner,
    base,
    call,
    branch: created.branch,
    member,
    plan: async (body: object = {}) =>
      (
        await call("POST", `${base}/plans`, {
          name: "Monthly",
          durationUnit: "month",
          durationCount: 1,
          pricePaise: 150_000,
          joiningFeePaise: 50_000,
          ...body,
        })
      ).json(),
    enrol: (planId: string, startDate?: string) =>
      call("POST", `${base}/members/${member.id}/memberships`, {
        planId,
        ...(startDate && { startDate }),
      }),
  };
}
