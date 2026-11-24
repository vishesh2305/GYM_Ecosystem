import { createHmac, timingSafeEqual } from "node:crypto";
import { v7 } from "uuid";

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
}

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
    return { orderId: `order_fake_${v7().replaceAll("-", "")}` };
  }
  async refund(): Promise<{ refundId: string }> {
    return { refundId: `rfnd_fake_${v7().replaceAll("-", "")}` };
  }
}

/** Razorpay REST API (orders, refunds). Not exercised by automated tests: needs real keys. */
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
    const body = await this.post("/orders", {
      amount: order.amountPaise,
      currency: "INR",
      receipt: order.receipt,
      notes: order.notes,
    });
    return { orderId: String(body.id) };
  }

  async refund(paymentId: string, amountPaise: number) {
    const body = await this.post(`/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount: amountPaise,
    });
    return { refundId: String(body.id) };
  }

  private async post(path: string, payload: object): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Razorpay ${path} failed with ${res.status}`);
    return body;
  }
}
