import { parseEnv } from "@gym/config";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiEnvSchema } from "../src/env";
import {
  createGateway,
  FakeGateway,
  RazorpayGateway,
  verifyWebhookSignature,
} from "../src/billing/gateway";
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
    const ids: Record<string, string> = { "/orders": "order_ABC123", "/customers": "cust_C1" };
    res.end(JSON.stringify({ id: ids[req.url ?? ""] ?? "rfnd_XYZ789" }));
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

describe("Razorpay UPI AutoPay", () => {
  const gateway = () => new RazorpayGateway("rzp_test_key", "secret", baseUrl);
  const payer = { name: "Asha", phone: "+919900000001", email: null };

  it("creates the customer, then a UPI order that asks for a mandate up to the limit", async () => {
    const before = seen.length;
    const result = await gateway().createMandateOrder({
      amountPaise: 236_000,
      maxAmountPaise: 236_000,
      receipt: "INV/26-27/000002",
      notes: { mandateId: "m" },
      payer,
    });
    expect(result).toEqual({ orderId: "order_ABC123", customerId: "cust_C1" });
    const [customer, order] = seen.slice(before);
    expect(customer).toMatchObject({
      url: "/customers",
      body: { name: "Asha", contact: "+919900000001", fail_existing: "0" },
    });
    expect(order).toMatchObject({
      url: "/orders",
      body: {
        amount: 236_000,
        customer_id: "cust_C1",
        method: "upi",
        token: { max_amount: 236_000, frequency: "as_presented" },
        notes: { mandateId: "m" },
      },
    });
  });

  it("sends the email instead of a phone number when that is all the member gave", async () => {
    const emailOnly = { name: "Ravi", phone: null, email: "ravi@example.com" };
    const before = seen.length;
    await gateway().createMandateOrder({
      amountPaise: 100,
      maxAmountPaise: 100,
      receipt: "r",
      notes: {},
      payer: emailOnly,
    });
    await gateway().chargeMandate({
      customerId: "cust_C1",
      tokenId: "token_T1",
      amountPaise: 100,
      receipt: "r",
      notes: {},
      payer: emailOnly,
    });
    const [customer, , , recurring] = seen.slice(before);
    expect(customer?.body).toEqual({ name: "Ravi", email: "ravi@example.com", fail_existing: "0" });
    expect(recurring?.body).toMatchObject({ email: "ravi@example.com" });
    expect(recurring?.body).not.toHaveProperty("contact");
  });

  it("charges a mandate with an order and a recurring payment, and cancels it", async () => {
    const before = seen.length;
    expect(
      await gateway().chargeMandate({
        customerId: "cust_C1",
        tokenId: "token_T1",
        amountPaise: 177_000,
        receipt: "INV/26-27/000003",
        notes: { paymentId: "p" },
        payer,
      }),
    ).toEqual({ orderId: "order_ABC123" });
    expect(seen.slice(before).map((s) => s.url)).toEqual(["/orders", "/payments/create/recurring"]);
    expect(seen.at(-1)?.body).toMatchObject({
      order_id: "order_ABC123",
      customer_id: "cust_C1",
      token: "token_T1",
      recurring: "1",
      amount: 177_000,
    });
    await gateway().cancelMandate("cust_C1", "token_T1");
    expect(seen.at(-1)).toMatchObject({
      method: "PUT",
      url: "/customers/cust_C1/tokens/token_T1/cancel",
    });
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
  it("use Razorpay only when it is chosen and has keys", () => {
    const env = (extra: Record<string, string> = {}) => parseEnv(apiEnvSchema, rawTestEnv(extra));
    expect(createGateway(env())).toBeInstanceOf(FakeGateway);
    const razorpay = createGateway(
      env({ PAYMENT_GATEWAY: "razorpay", RAZORPAY_KEY_ID: "rzp_test_k", RAZORPAY_KEY_SECRET: "s" }),
    );
    expect(razorpay).toBeInstanceOf(RazorpayGateway);
    expect(razorpay.keyId).toBe("rzp_test_k");
  });
});
