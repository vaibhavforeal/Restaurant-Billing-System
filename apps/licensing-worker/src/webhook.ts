import type { Plan } from "@forkflow/domain/licensing";
import type { Period } from "./env.js";
import { issueLicense, type Deps } from "./issue.js";
import { verifyWebhookSignature, type RazorpayApi } from "./razorpay.js";
import {
  eventSeen, getInstallation, getSubscription, latestLicenseForSubscription, newerChargedSubscriptionExists, olderOpenSubscriptions, paymentUsed,
  recordEventStatement, upsertSubscriptionStatement,
} from "./store.js";

export type WebhookDeps = Deps & { razorpay: RazorpayApi; webhookSecret: string; log: (msg: string) => void };

const GRACE_MS = 7 * 86_400_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const child = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);

interface Notes { installationId: string; plan: Plan; period: Period }
/** Razorpay sends `notes: []` when empty, so anything but a plain object with valid values counts as missing. */
function readNotes(notes: unknown): Notes | null {
  if (!isRecord(notes)) return null;
  const { installationId, plan, period } = notes;
  if (typeof installationId !== "string" || installationId === "") return null;
  if (plan !== "basic" && plan !== "pro") return null;
  if (period !== "monthly" && period !== "yearly") return null;
  return { installationId, plan, period };
}

export async function handleWebhook(deps: WebhookDeps, request: Request): Promise<Response> {
  const { db, log } = deps;
  const eventId = request.headers.get("x-razorpay-event-id");

  try {
    const rawBody = await request.text();
    if (!(await verifyWebhookSignature(rawBody, request.headers.get("x-razorpay-signature"), deps.webhookSecret))) return json({ error: "bad_signature" }, 400);
    if (!eventId) return json({ error: "missing_event_id" }, 400);
    if (await eventSeen(db, eventId)) return json({ outcome: "duplicate" });
    const now = deps.now();
    let body: unknown = null;
    try { body = JSON.parse(rawBody); } catch { /* signed but not JSON: nothing to act on */ }
    const type = typeof child(body, "event") === "string" ? (child(body, "event") as string) : "unknown";
    const record = async (outcome: string, detail?: string) => {
      if (detail) log(`webhook ${eventId} (${type}) ${outcome}: ${detail}`);
      await recordEventStatement(db, eventId, type, outcome, now).run();
      return json({ outcome });
    };

    const payload = child(body, "payload");
    const entity = child(child(payload, "subscription"), "entity");
    if (!type.startsWith("subscription.") || !isRecord(entity) || typeof entity.id !== "string") return await record("ignored");
    const subscriptionId = entity.id;
    const notes = readNotes(entity.notes);
    if (!notes) return await record("unmatched", `subscription ${subscriptionId} has no usable notes`);
    const installation = await getInstallation(db, notes.installationId);
    if (!installation) return await record("unmatched", `unknown installation ${notes.installationId}`);
    const status = typeof entity.status === "string" ? entity.status : type.slice("subscription.".length);
    const periodEnd = typeof entity.current_end === "number" && Number.isFinite(entity.current_end) ? entity.current_end * 1000 : null;
    const existing = await getSubscription(db, subscriptionId);
    // A row created here (the webhook beat /v1/subscriptions' write, or it was lost) takes Razorpay's creation time, so subscription order stays right.
    const createdAt = typeof entity.created_at === "number" && Number.isFinite(entity.created_at) ? entity.created_at * 1000 : now;
    const subscription = {
      razorpaySubscriptionId: subscriptionId, installationId: installation.installationId, plan: notes.plan, period: notes.period,
      status, currentPeriodEnd: periodEnd ?? existing?.currentPeriodEnd ?? null, createdAt: existing?.createdAt ?? createdAt,
    };

    if (type !== "subscription.charged") {
      await db.batch([upsertSubscriptionStatement(db, subscription), recordEventStatement(db, eventId, type, "status", now)]);
      return json({ outcome: "status" });
    }

    const paymentId = child(child(child(payload, "payment"), "entity"), "id");
    if (periodEnd === null || typeof paymentId !== "string") return await record("unmatched", `charge for ${subscriptionId} lacks current_end or a payment id`);
    if (await paymentUsed(db, paymentId)) return await record("ignored", `payment ${paymentId} already issued`);
    const latest = await latestLicenseForSubscription(db, subscriptionId);
    if (latest && periodEnd <= latest.expiresAt) return await record("ignored", `period end ${periodEnd} is not newer than ${latest.expiresAt}`);
    // A charge on a subscription that a newer, already charged one replaced must not hand the old plan the top revision.
    if (await newerChargedSubscriptionExists(db, installation.installationId, subscription.createdAt, subscriptionId)) {
      const response = await record("superseded", `subscription ${subscriptionId} was replaced by a newer charged subscription`);
      // Its cancel failed or was lost earlier, so try again; a failure is for manual follow-up, never a reason to fail the webhook.
      try { await deps.razorpay.cancelSubscription(subscriptionId); }
      catch (error) { log(`could not cancel superseded subscription ${subscriptionId}: ${error instanceof Error ? error.message : String(error)}`); }
      return response;
    }
    if (periodEnd <= now) return await record("ignored", `period end ${periodEnd} is not after now (${now})`);

    const { statement } = await issueLicense(deps, {
      installation, plan: notes.plan, expiresAt: periodEnd, graceUntil: periodEnd + GRACE_MS, trial: false, reason: "charge", subscriptionId, paymentId,
    });
    await db.batch([statement, upsertSubscriptionStatement(db, subscription), recordEventStatement(db, eventId, type, "issued", now)]);

    // Only a subscription's first paid charge retires the older ones (§3.5.3); renewals of an old subscription never touch a newer one still awaiting its first payment.
    // A failure here is for manual follow-up, never a reason to fail the webhook (the licence is already issued).
    if (!latest) {
      try {
        for (const older of await olderOpenSubscriptions(db, installation.installationId, subscription.createdAt, subscriptionId)) {
          try { await deps.razorpay.cancelSubscription(older.razorpaySubscriptionId); }
          catch (error) { log(`could not cancel superseded subscription ${older.razorpaySubscriptionId}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } catch (error) { log(`could not list superseded subscriptions for ${installation.installationId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return json({ outcome: "issued" });
  } catch (error) {
    log(`webhook ${eventId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return json({ error: "unavailable" }, 500);
  }
}
