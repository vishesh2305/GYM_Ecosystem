// Synthetic check of the journeys that matter most, run against a live environment every 10 minutes by
// Grafana Synthetic Monitoring (infra/terraform/modules/observability): a member signs in, checks in at the
// gym's kiosk and out again, and a signed payment notification from the gateway is accepted while a forged
// one is refused. Needs the demo gym (pnpm db:seed) and a test sign-in number (OTP_TEST_NUMBERS, staging only).
//
// Run by hand:  docker run --rm -i -e BASE_URL=... -e SYNTH_PHONE=... -e SYNTH_OTP=... \
//   -e SYNTH_KIOSK_TOKEN=... -e SYNTH_WEBHOOK_SECRET=... grafana/k6:2.3.0 run - < infra/synthetics/critical-flows.js
import { check, fail, group } from "k6";
import crypto from "k6/crypto";
import http from "k6/http";

export const options = { iterations: 1, thresholds: { checks: ["rate==1"] } };

const env = (name) => __ENV[name] || fail(`${name} is not set`);
const BASE = env("BASE_URL").replace(/\/$/, "");
const headers = (extra = {}) => ({ headers: { "content-type": "application/json", ...extra } });
const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

/** RFC 4648 base32 to bytes. */
function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out = [];
  let bits = 0;
  let value = 0;
  for (const c of text.replace(/=+$/, "").toUpperCase()) {
    value = ((value << 5) | alphabet.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out).buffer;
}

/** The code the member app shows on its pass (RFC 6238 TOTP, SHA-1). */
function totp(secret, digits, period) {
  const message = new Uint8Array(8);
  let counter = Math.floor(Date.now() / 1000 / period);
  for (let i = 7; i >= 0; i--) {
    message[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hash = crypto
    .hmac("sha1", base32(secret), message.buffer, "hex")
    .match(/../g)
    .map((h) => parseInt(h, 16));
  const o = hash[hash.length - 1] & 0xf;
  const n = ((hash[o] & 0x7f) << 24) | (hash[o + 1] << 16) | (hash[o + 2] << 8) | hash[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

export default function () {
  let token;
  let orgId;

  group("sign in", () => {
    const asked = http.post(
      `${BASE}/v1/auth/otp/request`,
      JSON.stringify({ channel: "sms", phone: env("SYNTH_PHONE") }),
      headers(),
    );
    check(asked, { "code requested": (r) => r.status === 202 });
    const signedIn = http.post(
      `${BASE}/v1/auth/otp/verify`,
      JSON.stringify({
        challengeId: asked.json("challengeId"),
        code: env("SYNTH_OTP"),
        deviceName: "Synthetic check",
      }),
      headers(),
    );
    check(signedIn, { "signed in": (r) => r.status === 200 });
    token = signedIn.json("accessToken");
  });
  if (!token) fail("could not sign in");

  group("check in", () => {
    const gyms = http.get(`${BASE}/v1/me/gyms`, bearer(token));
    check(gyms, { "my gyms listed": (r) => r.status === 200 && r.json("#") > 0 });
    orgId = gyms.json("0.orgId");
    const pass = http.get(`${BASE}/v1/me/gyms/${orgId}/pass`, bearer(token));
    check(pass, { "pass shown": (r) => r.status === 200 });
    const { qrPrefix, secret, digits, period } = pass.json();
    const scanned = http.post(
      `${BASE}/v1/kiosk/check-ins`,
      JSON.stringify({ code: qrPrefix + totp(secret, digits, period) }),
      headers({ "x-kiosk-token": env("SYNTH_KIOSK_TOKEN") }),
    );
    check(scanned, { "kiosk let the member in": (r) => r.status === 200 && r.json("allowed") });
    const out = http.post(`${BASE}/v1/me/gyms/${orgId}/check-out`, null, bearer(token));
    check(out, { "checked out": (r) => r.status === 200 });
  });

  group("payment notification", () => {
    // A well-formed event for a payment that does not exist: verified, parsed, looked up, then ignored.
    const body = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_synthetic",
            order_id: "order_synthetic",
            amount: 100,
            notes: { tenantId: orgId, paymentId: "00000000-0000-7000-8000-00000000c0de" },
          },
        },
      },
    });
    const signature = crypto.hmac("sha256", env("SYNTH_WEBHOOK_SECRET"), body, "hex");
    const signed = http.post(
      `${BASE}/v1/webhooks/razorpay`,
      body,
      headers({ "x-razorpay-signature": signature }),
    );
    check(signed, { "signed notification accepted": (r) => r.status === 200 });
    const forged = http.post(
      `${BASE}/v1/webhooks/razorpay`,
      body,
      headers({ "x-razorpay-signature": "0".repeat(64) }),
    );
    check(forged, { "forged notification refused": (r) => r.status === 400 });
  });

  http.post(`${BASE}/v1/auth/logout`, null, bearer(token));
}
