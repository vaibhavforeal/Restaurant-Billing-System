import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./razorpay.js";

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");

describe("verifyWebhookSignature", () => {
  const body = '{"event":"payment_link.paid"}';
  it("accepts a valid signature", async () => expect(await verifyWebhookSignature(body, sign(body, "s3cret"), "s3cret")).toBe(true));
  it("rejects a tampered body", async () => expect(await verifyWebhookSignature(`${body} `, sign(body, "s3cret"), "s3cret")).toBe(false));
  it("rejects a wrong secret", async () => expect(await verifyWebhookSignature(body, sign(body, "other"), "s3cret")).toBe(false));
  it("rejects a missing header", async () => {
    expect(await verifyWebhookSignature(body, null, "s3cret")).toBe(false);
    expect(await verifyWebhookSignature(body, "", "s3cret")).toBe(false);
  });
  it("rejects malformed hex without throwing", async () => {
    expect(await verifyWebhookSignature(body, "not-hex!", "s3cret")).toBe(false);
    expect(await verifyWebhookSignature(body, sign(body, "s3cret").slice(1), "s3cret")).toBe(false);
    expect(await verifyWebhookSignature(body, sign(body, "s3cret").slice(0, 10), "s3cret")).toBe(false);
  });
  it("accepts an uppercase hex signature", async () => expect(await verifyWebhookSignature(body, sign(body, "s3cret").toUpperCase(), "s3cret")).toBe(true));
});
