import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { planIdFor, razorpayApi, TOTAL_COUNT, verifyWebhookSignature } from "./razorpay.js";

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recorder = (response: () => Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe("verifyWebhookSignature", () => {
  const body = '{"event":"subscription.charged"}';
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

describe("razorpayApi", () => {
  it("createSubscription posts the expected request", async () => {
    const { calls, fetchImpl } = recorder(() => reply(200, { id: "sub_1", status: "created", short_url: "x" }));
    const out = await razorpayApi("rzp_key", "rzp_secret", fetchImpl).createSubscription({ planId: "plan_A", totalCount: 120, notes: { installationId: "i1" } });
    expect(out).toEqual({ id: "sub_1", status: "created" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.razorpay.com/v1/subscriptions");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("rzp_key:rzp_secret")}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ plan_id: "plan_A", total_count: 120, customer_notify: true, notes: { installationId: "i1" } });
  });

  it("cancelSubscription posts an immediate cancel", async () => {
    const { calls, fetchImpl } = recorder(() => reply(200, { id: "sub_1", status: "cancelled" }));
    await razorpayApi("k", "s", fetchImpl).cancelSubscription("sub_1");
    expect(calls[0]!.url).toBe("https://api.razorpay.com/v1/subscriptions/sub_1/cancel");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ cancel_at_cycle_end: false });
  });

  it("a 400 throws with Razorpay's description", async () => {
    const { fetchImpl } = recorder(() => reply(400, { error: { code: "BAD_REQUEST_ERROR", description: "The plan id provided is invalid." } }));
    await expect(razorpayApi("k", "s", fetchImpl).createSubscription({ planId: "bad", totalCount: 1, notes: {} })).rejects.toThrow("Razorpay 400: The plan id provided is invalid.");
  });

  it("a non-JSON error body still throws with the status", async () => {
    const { fetchImpl } = recorder(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(razorpayApi("k", "s", fetchImpl).cancelSubscription("sub_1")).rejects.toThrow(/^Razorpay 502/);
  });
});

describe("plan ids and totals", () => {
  const env = { RAZORPAY_PLAN_BASIC_MONTHLY: "pb_m", RAZORPAY_PLAN_BASIC_YEARLY: "pb_y", RAZORPAY_PLAN_PRO_MONTHLY: "pp_m", RAZORPAY_PLAN_PRO_YEARLY: "pp_y" } as Env;
  it("maps plan and period to the configured Razorpay plan id", () => {
    expect(planIdFor(env, "basic", "monthly")).toBe("pb_m");
    expect(planIdFor(env, "basic", "yearly")).toBe("pb_y");
    expect(planIdFor(env, "pro", "monthly")).toBe("pp_m");
    expect(planIdFor(env, "pro", "yearly")).toBe("pp_y");
  });
  it("total_count", () => expect(TOTAL_COUNT).toEqual({ monthly: 120, yearly: 10 }));
});
