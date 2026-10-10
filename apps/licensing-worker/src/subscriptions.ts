import { z } from "zod";
import type { Deps } from "./issue.js";
import type { Env } from "./env.js";
import { planIdFor, TOTAL_COUNT, type RazorpayApi } from "./razorpay.js";
import { getInstallation, setContactEmailStatement, upsertSubscriptionStatement } from "./store.js";

const CheckoutRequest = z.object({
  installationId: z.string().uuid(), plan: z.enum(["basic", "pro"]), period: z.enum(["monthly", "yearly"]), email: z.string().max(254).email(),
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleCreateSubscription(deps: Deps & { razorpay: RazorpayApi; env: Env }, body: unknown): Promise<Response> {
  const parsed = CheckoutRequest.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const { installationId, plan, period, email } = parsed.data;
  const { db, env } = deps;
  if (!(await getInstallation(db, installationId))) return json({ error: "unknown_installation" }, 404);

  let created: { id: string; status: string };
  try {
    created = await deps.razorpay.createSubscription({ planId: planIdFor(env, plan, period), totalCount: TOTAL_COUNT[period], notes: { installationId, plan, period } });
  } catch (error) {
    // Nothing is written: no subscription exists on our side, and the admin can simply try again.
    console.error("licensing-worker: Razorpay subscription create failed:", error instanceof Error ? error.message : "unknown error");
    return json({ error: "payment_provider" }, 502);
  }
  // The row carries Razorpay's own status and no period end yet; the verified webhook fills in the rest after the first charge.
  await db.batch([
    setContactEmailStatement(db, installationId, email),
    upsertSubscriptionStatement(db, { razorpaySubscriptionId: created.id, installationId, plan, period, status: created.status, currentPeriodEnd: null, createdAt: deps.now() }),
  ]);
  return json({ subscriptionId: created.id, keyId: env.RAZORPAY_KEY_ID });
}
