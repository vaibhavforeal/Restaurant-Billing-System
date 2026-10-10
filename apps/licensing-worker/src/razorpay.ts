// Razorpay facts this file and the webhook handler depend on (verified against the official docs, 2026-10-10):
// - Create: POST https://api.razorpay.com/v1/subscriptions, JSON { plan_id, total_count, customer_notify (boolean, default true), notes (<= 15 pairs) },
//   HTTP Basic auth (key id : key secret); returns { id, status: "created" | ..., current_end: null until the first cycle, notes }.
//   https://razorpay.com/docs/api/payments/subscriptions/create-subscription/
// - Cancel: POST https://api.razorpay.com/v1/subscriptions/{id}/cancel, body { cancel_at_cycle_end } (boolean; false = immediately, the default).
//   https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/
// - Errors are 4xx JSON: { error: { code, description, ... } }.
// - Webhook signature: header `X-Razorpay-Signature` = hex HMAC-SHA256 of the RAW request body keyed by the webhook secret; never parse before verifying.
//   Dedupe header: `X-Razorpay-Event-Id` (unique per event). https://razorpay.com/docs/webhooks/validate-test/
// - Events: subscription.charged | activated | halted | cancelled | completed (also authenticated, pending, updated, paused, resumed).
//   Body: { event, payload: { subscription: { entity: { id, status, current_end (Unix SECONDS, null before the first cycle), notes } },
//   payment: { entity: { id } } } }. `payment` is present for subscription.charged and subscription.completed only; other events carry only `subscription`.
//   `notes` is an object when set but `[]` (an empty array) when empty. https://razorpay.com/docs/webhooks/subscriptions/ (markdown: add ".md")
import type { Plan } from "@forkflow/domain/licensing";
import type { Env, Period } from "./env.js";

export const TOTAL_COUNT: Record<Period, number> = { monthly: 120, yearly: 10 };

const API = "https://api.razorpay.com/v1";
const PLAN_KEYS = {
  basic: { monthly: "RAZORPAY_PLAN_BASIC_MONTHLY", yearly: "RAZORPAY_PLAN_BASIC_YEARLY" },
  pro: { monthly: "RAZORPAY_PLAN_PRO_MONTHLY", yearly: "RAZORPAY_PLAN_PRO_YEARLY" },
} as const;

export const planIdFor = (env: Env, plan: Plan, period: Period): string => env[PLAN_KEYS[plan][period]];

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

export interface RazorpayApi {
  createSubscription(input: { planId: string; totalCount: number; notes: Record<string, string> }): Promise<{ id: string; status: string }>;
  cancelSubscription(id: string): Promise<void>;
}

export function razorpayApi(keyId: string, keySecret: string, fetchImpl: typeof fetch = fetch): RazorpayApi {
  const authorization = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${API}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
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
    async createSubscription({ planId, totalCount, notes }) {
      const created = (await post("/subscriptions", { plan_id: planId, total_count: totalCount, customer_notify: true, notes })) as { id: string; status: string };
      return { id: created.id, status: created.status };
    },
    async cancelSubscription(id) { await post(`/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: false }); },
  };
}
