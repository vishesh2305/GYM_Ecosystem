import { createDb, type DbHandle } from "@gym/db";
import { eq } from "@gym/db/orm";
import { authIdentities } from "@gym/db/schema";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ConsoleEmailSender } from "../src/auth/senders";
import { EMAIL_SENDER } from "../src/tokens";
import { testEnv } from "./helpers";

// A local stand-in for Google's and Apple's public key endpoints, so real signature checks run.
let server: Server;
let baseUrl: string;
const keys: Record<string, { privateKey: CryptoKey; jwk: JWK }> = {};
const NONCE = "n-0S6_WzA2Mj";

let api: Awaited<ReturnType<typeof createApp>>["app"];
let dbh: DbHandle;

async function idToken(
  provider: "google" | "apple",
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expiresIn?: string; key?: CryptoKey } = {},
) {
  const issuer =
    opts.issuer ??
    (provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com");
  const audience =
    opts.audience ??
    (provider === "google" ? "web-client.apps.googleusercontent.com" : "com.gym.app");
  const nonce = provider === "google" ? NONCE : createHash("sha256").update(NONCE).digest("hex");
  return new SignJWT({ nonce, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: provider })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(opts.key ?? (keys[provider]?.privateKey as CryptoKey));
}

const signIn = (provider: string, token: string, extra: Record<string, unknown> = {}) =>
  api.inject({
    method: "POST",
    url: `/v1/auth/social/${provider}`,
    payload: { idToken: token, nonce: NONCE, ...extra },
  });
const me = async (accessToken: string) =>
  (
    await api.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    })
  ).json();

beforeAll(async () => {
  for (const provider of ["google", "apple"]) {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    keys[provider] = {
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid: provider, alg: "RS256", use: "sig" },
    };
  }
  server = createServer((req, res) => {
    const provider = req.url?.slice(1) ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [keys[provider]?.jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ({ app: api } = await createApp(
    testEnv({
      GOOGLE_CLIENT_IDS:
        "web-client.apps.googleusercontent.com,android-client.apps.googleusercontent.com",
      GOOGLE_JWKS_URL: `${baseUrl}/google`,
      APPLE_CLIENT_IDS: "com.gym.app",
      APPLE_JWKS_URL: `${baseUrl}/apple`,
    }),
  ));
  dbh = createDb(testEnv().DATABASE_URL);
});
afterAll(async () => {
  await api.close();
  await dbh.pool.end();
  server.close();
});

describe("sign in with Google", () => {
  it("creates an account with the verified email, then signs into the same account", async () => {
    const sub = `g-${Date.now()}`;
    const email = `${sub}@gmail.com`;
    const first = await signIn(
      "google",
      await idToken("google", { sub, email, email_verified: true, name: "Asha" }),
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().isNewUser).toBe(true);
    const profile = await me(first.json().accessToken);
    expect(profile).toMatchObject({ email, name: "Asha" });

    const again = await signIn(
      "google",
      await idToken("google", { sub, email, email_verified: true }),
    );
    expect(again.json().isNewUser).toBe(false);
    expect((await me(again.json().accessToken)).id).toBe(profile.id);
  });

  it("joins an existing account that already proved the same email", async () => {
    const email = `linked.${Date.now()}@example.com`;
    const mail = api.get<ConsoleEmailSender>(EMAIL_SENDER);
    const req = await api.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { channel: "email", email },
    });
    const code = /\b(\d{6})\b/.exec(mail.sent.at(-1)?.text ?? "")?.[1];
    const viaCode = await api.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      payload: { challengeId: req.json().challengeId, code },
    });
    const existing = await me(viaCode.json().accessToken);

    const viaGoogle = await signIn(
      "google",
      await idToken("google", { sub: `g-link-${Date.now()}`, email, email_verified: true }),
    );
    expect(viaGoogle.json().isNewUser).toBe(false);
    expect((await me(viaGoogle.json().accessToken)).id).toBe(existing.id);
  });

  it("never trusts an unverified email: a separate account without that email is created", async () => {
    const email = `unverified.${Date.now()}@example.com`;
    const res = await signIn(
      "google",
      await idToken("google", { sub: `g-unv-${Date.now()}`, email, email_verified: false }),
    );
    expect(res.json().isNewUser).toBe(true);
    expect((await me(res.json().accessToken)).email).toBeNull();
  });

  it("accepts any configured client id (web, Android, iOS)", async () => {
    const token = await idToken(
      "google",
      { sub: `g-android-${Date.now()}` },
      { audience: "android-client.apps.googleusercontent.com" },
    );
    expect((await signIn("google", token)).statusCode).toBe(200);
  });

  it("rejects forged, expired, foreign or replayed tokens", async () => {
    const sub = `g-bad-${Date.now()}`;
    const { privateKey: stranger } = await generateKeyPair("RS256");
    const bad = [
      await idToken("google", { sub }, { key: stranger }),
      await idToken("google", { sub }, { expiresIn: "-1m" }),
      await idToken("google", { sub }, { audience: "someone-elses-app" }),
      await idToken("google", { sub }, { issuer: "https://evil.example" }),
      "not.a.token",
    ];
    for (const token of bad) expect((await signIn("google", token)).statusCode).toBe(401);
    const wrongNonce = await signIn("google", await idToken("google", { sub }), {
      nonce: "different-nonce",
    });
    expect(wrongNonce.statusCode).toBe(401);
    const noNonce = await api.inject({
      method: "POST",
      url: "/v1/auth/social/google",
      payload: { idToken: await idToken("google", { sub }) },
    });
    expect(noNonce.statusCode).toBe(400);
  });
});

describe("sign in with Apple", () => {
  it("checks the hashed nonce, accepts email_verified as text and uses the name sent on first sign-in", async () => {
    const sub = `001234.${Date.now()}`;
    const res = await signIn(
      "apple",
      await idToken("apple", {
        sub,
        email: `${Date.now()}@privaterelay.appleid.com`,
        email_verified: "true",
      }),
      { name: "Ravi Kumar" },
    );
    expect(res.statusCode).toBe(200);
    const profile = await me(res.json().accessToken);
    expect(profile.name).toBe("Ravi Kumar");
    const [identity] = await dbh.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.subject, sub));
    expect(identity).toMatchObject({ provider: "apple", userId: profile.id });
  });
});

describe("availability", () => {
  it("answers 400 when a provider is not configured, and for unknown providers", async () => {
    const plain = await createApp(testEnv());
    try {
      const res = await plain.app.inject({
        method: "POST",
        url: "/v1/auth/social/google",
        payload: { idToken: "x", nonce: NONCE },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/not available/);
    } finally {
      await plain.app.close();
    }
    expect((await signIn("facebook", "x")).statusCode).toBe(400);
  });
});
