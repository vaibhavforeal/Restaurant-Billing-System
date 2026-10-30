// Razorpay facts this file and the webhook handler depend on (verified against the official docs):
// - Webhook signature: header `X-Razorpay-Signature` = hex HMAC-SHA256 of the RAW request body keyed by the webhook secret; never parse before verifying.
//   Dedupe header: `X-Razorpay-Event-Id` (unique per event). https://razorpay.com/docs/webhooks/validate-test/
// - Errors are 4xx JSON: { error: { code, description, ... } }.

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
