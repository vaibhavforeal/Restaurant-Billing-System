// Razorpay facts this file and the webhook handler depend on (verified against the official docs):
// - Webhook signature: header `X-Razorpay-Signature` = hex HMAC-SHA256 of the RAW request body keyed by the webhook secret; never parse before verifying.
//   Dedupe header: `X-Razorpay-Event-Id` (unique per event). https://razorpay.com/docs/webhooks/validate-test/
// - Errors are 4xx JSON: { error: { code, description, ... } }.
// - Payment Links: POST /v1/payment_links with JSON { amount (paise, >= 100), currency "INR", accept_partial, reference_id (<= 40 chars, never
//   reusable, even after the link is cancelled or expired), description, customer { name, email, contact }, notify { sms, email }, expire_by
//   (Unix seconds, 15 minutes to 6 months ahead), notes (<= 15 pairs) }; returns { id: "plink_...", short_url, status }.
//   Cancel: POST /v1/payment_links/{id}/cancel, only while the link is "created". https://razorpay.com/docs/api/payments/payment-links/create-standard/
// - Webhooks payment_link.paid | partially_paid | cancelled | expired carry payload.payment_link.entity { id, status, amount, amount_paid, reference_id }
//   and, for the payment events, payload.payment.entity { id, amount, status: "captured", method }. https://razorpay.com/docs/webhooks/payment-links/

const hexBytes = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export async function verifyWebhookSignature(rawBody: string, signatureHex: string | null, secret: string): Promise<boolean> {
  const signature = signatureHex ? hexBytes(signatureHex.trim()) : null;
  if (!signature) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, signature, enc.encode(rawBody));
  } catch { return false; }
}

export interface PaymentLinkInput {
  amountPaise: number; referenceId: string; description: string; expireBy: number;
  customer: { name: string; email: string | null; contact: string | null }; notes: Record<string, string>;
}
export interface RazorpayApi {
  createPaymentLink(input: PaymentLinkInput): Promise<{ id: string; shortUrl: string; status: string }>;
  cancelPaymentLink(id: string): Promise<void>;
}

const API = "https://api.razorpay.com/v1";

export function razorpayApi(keyId: string, keySecret: string, fetchImpl: typeof fetch = fetch): RazorpayApi {
  const authorization = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${API}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!response.ok) {
      const description = (parsed as { error?: { description?: unknown } } | null)?.error?.description;
      throw new Error(`Razorpay ${response.status}: ${typeof description === "string" ? description : response.statusText || "request failed"}`);
    }
    return parsed;
  };
  return {
    async createPaymentLink(input) {
      const body = await post("/payment_links", {
        amount: input.amountPaise, currency: "INR", accept_partial: false, reference_id: input.referenceId, description: input.description.slice(0, 2048),
        customer: { name: input.customer.name, ...(input.customer.email ? { email: input.customer.email } : {}), ...(input.customer.contact ? { contact: input.customer.contact } : {}) },
        notify: { sms: !!input.customer.contact, email: !!input.customer.email }, reminder_enable: true, expire_by: Math.floor(input.expireBy / 1000), notes: input.notes,
      }) as { id?: unknown; short_url?: unknown; status?: unknown } | null;
      if (typeof body?.id !== "string" || typeof body.short_url !== "string") throw new Error("Razorpay: unexpected payment link response");
      return { id: body.id, shortUrl: body.short_url, status: typeof body.status === "string" ? body.status : "created" };
    },
    async cancelPaymentLink(id) { await post(`/payment_links/${encodeURIComponent(id)}/cancel`); },
  };
}
