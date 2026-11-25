import { createHmac, timingSafeEqual } from "node:crypto";
import { v7 } from "uuid";
import type { ApiEnv } from "../env";

/** What billing needs from a payment gateway. One adapter per gateway (ADR 006). */
export interface PaymentGateway {
  readonly name: "fake" | "razorpay";
  /** Public key the app's checkout needs. */
  readonly keyId: string;
  createOrder(order: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string }>;
  refund(paymentId: string, amountPaise: number): Promise<{ refundId: string }>;
  /** First payment that also asks the member to approve UPI AutoPay up to `maxAmountPaise` per charge. */
  createMandateOrder(order: MandateOrder): Promise<{ orderId: string; customerId: string }>;
  /** Charge an approved mandate. The result arrives later by webhook, like any online payment. */
  chargeMandate(charge: MandateCharge): Promise<{ orderId: string }>;
  cancelMandate(customerId: string, tokenId: string): Promise<void>;
}

export interface Payer {
  name: string;
  phone: string | null;
  email: string | null;
}

export interface MandateOrder {
  amountPaise: number;
  maxAmountPaise: number;
  receipt: string;
  notes: Record<string, string>;
  payer: Payer;
}

export interface MandateCharge {
  customerId: string;
  tokenId: string;
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
  payer: Payer;
}

const fakeId = (prefix: string) => `${prefix}_fake_${v7().replaceAll("-", "")}`;

/** Razorpay signs webhooks with HMAC-SHA256 of the raw body using the webhook secret (hex). */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Development/tests: pretend orders and refunds. Refused in production by env validation. */
export class FakeGateway implements PaymentGateway {
  readonly name = "fake" as const;
  readonly keyId = "rzp_test_fake";
  async createOrder(): Promise<{ orderId: string }> {
    return { orderId: fakeId("order") };
  }
  async refund(): Promise<{ refundId: string }> {
    return { refundId: fakeId("rfnd") };
  }
  async createMandateOrder(): Promise<{ orderId: string; customerId: string }> {
    return { orderId: fakeId("order"), customerId: fakeId("cust") };
  }
  async chargeMandate(): Promise<{ orderId: string }> {
    return { orderId: fakeId("order") };
  }
  async cancelMandate(): Promise<void> {}
}

/** UPI AutoPay mandates are approved for this long. */
const MANDATE_YEARS = 5;

/**
 * Razorpay REST API (orders, refunds, UPI AutoPay). Tested against a local stand-in only: check every call with
 * test keys before going live.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay" as const;
  private readonly auth: string;

  constructor(
    readonly keyId: string,
    keySecret: string,
    private readonly baseUrl = "https://api.razorpay.com/v1",
  ) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  async createOrder(order: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }) {
    const body = await this.send("/orders", {
      amount: order.amountPaise,
      currency: "INR",
      receipt: order.receipt,
      notes: order.notes,
    });
    return { orderId: String(body.id) };
  }

  async refund(paymentId: string, amountPaise: number) {
    const body = await this.send(`/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount: amountPaise,
    });
    return { refundId: String(body.id) };
  }

  async createMandateOrder(order: MandateOrder) {
    const customer = await this.send("/customers", {
      name: order.payer.name,
      contact: order.payer.phone ?? undefined,
      email: order.payer.email ?? undefined,
      fail_existing: "0", // returns the existing customer for the same contact
    });
    const customerId = String(customer.id);
    const expireAt = Math.floor(Date.now() / 1000) + MANDATE_YEARS * 365 * 86_400;
    const body = await this.send("/orders", {
      amount: order.amountPaise,
      currency: "INR",
      customer_id: customerId,
      method: "upi",
      token: { max_amount: order.maxAmountPaise, expire_at: expireAt, frequency: "as_presented" },
      receipt: order.receipt,
      notes: order.notes,
    });
    return { orderId: String(body.id), customerId };
  }

  async chargeMandate(charge: MandateCharge) {
    const order = await this.send("/orders", {
      amount: charge.amountPaise,
      currency: "INR",
      payment_capture: true,
      receipt: charge.receipt,
      notes: charge.notes,
    });
    const orderId = String(order.id);
    await this.send("/payments/create/recurring", {
      email: charge.payer.email ?? undefined,
      contact: charge.payer.phone ?? undefined,
      amount: charge.amountPaise,
      currency: "INR",
      order_id: orderId,
      customer_id: charge.customerId,
      token: charge.tokenId,
      recurring: "1",
      description: charge.receipt,
      notes: charge.notes,
    });
    return { orderId };
  }

  async cancelMandate(customerId: string, tokenId: string) {
    await this.send(
      `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}/cancel`,
      {},
      "PUT",
    );
  }

  private async send(
    path: string,
    payload: object,
    method: "POST" | "PUT" = "POST",
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Razorpay ${path} failed with ${res.status}`);
    return body;
  }
}

/** Razorpay when configured with keys, otherwise the fake (env validation refuses the fake in production). */
export const createGateway = (env: ApiEnv): PaymentGateway =>
  env.PAYMENT_GATEWAY === "razorpay" && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET)
    : new FakeGateway();
