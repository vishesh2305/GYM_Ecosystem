import { parseEnv } from "@gym/config";
import { withTenant, type Database } from "@gym/db";
import { members, memberships, staffMembers, users } from "@gym/db/schema";
import { addDays } from "@gym/domain";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
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
    // Each test file has its own database and queue prefix (see setup-db.ts).
    DATABASE_URL:
      (globalThis as { __testDatabaseUrl?: string }).__testDatabaseUrl ?? inject("databaseUrl"),
    QUEUE_PREFIX: (globalThis as { __testQueuePrefix?: string }).__testQueuePrefix ?? "bull",
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
    payload?: object | string;
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
    /** `count` more members at the main branch, each with a free running 30-day membership. */
    membersWithMembership: async (count: number): Promise<string[]> => {
      const planId = (
        await call("POST", `${base}/plans`, {
          name: "Free month",
          durationUnit: "month",
          durationCount: 1,
          pricePaise: 0,
        })
      ).json().id;
      const today = new Date().toISOString().slice(0, 10);
      const orgId = created.organisation.id;
      return withTenant(db, orgId, async (tx) => {
        const people = await tx
          .insert(members)
          .values(
            Array.from({ length: count }, (_, i) => ({
              tenantId: orgId,
              name: `Member ${i + 1}`,
              homeBranchId: created.branch.id,
            })),
          )
          .returning({ id: members.id });
        await tx.insert(memberships).values(
          people.map((p) => ({
            tenantId: orgId,
            memberId: p.id,
            planId,
            planName: "Free month",
            status: "active" as const,
            startDate: today,
            endDate: addDays(today, 29),
            isTrial: false,
            pricePaise: 0,
            joiningFeePaise: 0,
            gstRateBps: 0,
            gstPaise: 0,
            totalPaise: 0,
            maxFreezes: 0,
            maxFreezeDays: 0,
          })),
        );
        return people.map((p) => p.id);
      });
    },
    /** Another signed-in staff member of this gym with `role` (limited to `branchIds` when given). */
    staff: async (
      role: "owner" | "manager" | "front_desk" | "trainer",
      branchIds: string[] = [],
    ) => {
      const person = await signedInStaff(app, db);
      await withTenant(db, created.organisation.id, (tx) =>
        tx
          .insert(staffMembers)
          .values({ tenantId: created.organisation.id, userId: person.user.id, role, branchIds }),
      );
      return person;
    },
    enrol: (planId: string, startDate?: string) =>
      call("POST", `${base}/members/${member.id}/memberships`, {
        planId,
        ...(startDate && { startDate }),
      }),
  };
}

/**
 * What Razorpay would send for a payment on `order`: the same body shape and the same HMAC-SHA256 signature
 * over the raw body. `extra` adds fields to the payment entity (for example `token_id`).
 */
export function razorpayWebhook(
  app: Injectable,
  event: string,
  order: { orderId: string; amountPaise: number; notes: Record<string, string> },
  {
    paymentId = `pay_${Math.random().toString(36).slice(2)}`,
    secret = "dev-webhook-secret",
    extra = {},
  }: { paymentId?: string; secret?: string; extra?: Record<string, unknown> } = {},
) {
  const body = JSON.stringify({
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: order.orderId,
          amount: order.amountPaise,
          currency: "INR",
          method: "upi",
          notes: order.notes,
          ...extra,
        },
      },
    },
  });
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/razorpay",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": createHmac("sha256", secret).update(body).digest("hex"),
    },
    payload: body,
  });
}
