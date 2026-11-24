import { parseEnv } from "@gym/config";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiEnvSchema } from "../src/env";
import { RazorpayGateway, verifyWebhookSignature } from "../src/billing/gateway";
import { rawTestEnv } from "./helpers";

// A local stand-in for api.razorpay.com that records what the adapter sends.
const seen: {
  method: string | undefined;
  url: string | undefined;
  auth: string | undefined;
  body: unknown;
}[] = [];
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(raw || "{}"),
    });
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("fail")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { description: "bad request" } }));
      return;
    }
    res.end(JSON.stringify({ id: req.url === "/orders" ? "order_ABC123" : "rfnd_XYZ789" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe("Razorpay adapter", () => {
  const gateway = () => new RazorpayGateway("rzp_test_key", "secret", baseUrl);

  it("creates orders with basic auth, amount in paise, receipt and notes", async () => {
    const { orderId } = await gateway().createOrder({
      amountPaise: 236_000,
      receipt: "INV/26-27/000001",
      notes: { tenantId: "t" },
    });
    expect(orderId).toBe("order_ABC123");
    expect(seen.at(-1)).toEqual({
      method: "POST",
      url: "/orders",
      auth: `Basic ${Buffer.from("rzp_test_key:secret").toString("base64")}`,
      body: {
        amount: 236_000,
        currency: "INR",
        receipt: "INV/26-27/000001",
        notes: { tenantId: "t" },
      },
    });
  });

  it("refunds a payment and reports gateway errors", async () => {
    expect(await gateway().refund("pay_1", 5000)).toEqual({ refundId: "rfnd_XYZ789" });
    expect(seen.at(-1)).toMatchObject({ url: "/payments/pay_1/refund", body: { amount: 5000 } });
    await expect(gateway().refund("fail", 1)).rejects.toThrow(/failed with 400/);
  });
});

describe("webhook signatures", () => {
  it("accepts only the exact HMAC-SHA256 of the raw body", () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const good = "1c7c2b8f"; // wrong length on purpose
    expect(verifyWebhookSignature(body, good, "s")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "s")).toBe(false);
  });
});

describe("payment settings", () => {
  it("refuse the fake gateway or the default webhook secret in production, and Razorpay without keys", () => {
    const prod = {
      NODE_ENV: "production",
      SMS_PROVIDER: "console",
      EMAIL_PROVIDER: "smtp",
      SMTP_URL: "smtp://x",
    };
    expect(() => parseEnv(apiEnvSchema, rawTestEnv({ ...prod }))).toThrow(/PAYMENT_GATEWAY/);
    expect(() => parseEnv(apiEnvSchema, rawTestEnv({ ...prod }))).toThrow(
      /RAZORPAY_WEBHOOK_SECRET/,
    );
    expect(() => parseEnv(apiEnvSchema, rawTestEnv({ PAYMENT_GATEWAY: "razorpay" }))).toThrow(
      /RAZORPAY_KEY_ID/,
    );
  });
});
