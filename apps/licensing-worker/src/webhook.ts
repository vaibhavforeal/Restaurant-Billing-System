import type { Deps } from "./issue.js";
import { verifyWebhookSignature } from "./razorpay.js";
import { eventSeen, recordEventStatement } from "./store.js";

export type WebhookDeps = Deps & { webhookSecret: string; log: (msg: string) => void };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Razorpay webhooks: every signed event is recorded once, by its event id; a replay is answered `duplicate` and changes nothing. */
export async function handleWebhook(deps: WebhookDeps, request: Request): Promise<Response> {
  const { db, log } = deps;
  const eventId = request.headers.get("x-razorpay-event-id");
  try {
    const rawBody = await request.text();
    if (!(await verifyWebhookSignature(rawBody, request.headers.get("x-razorpay-signature"), deps.webhookSecret))) return json({ error: "bad_signature" }, 400);
    if (!eventId) return json({ error: "missing_event_id" }, 400);
    if (await eventSeen(db, eventId)) return json({ outcome: "duplicate" });
    let body: unknown = null;
    try { body = JSON.parse(rawBody); } catch { /* signed but not JSON: nothing to act on */ }
    const type = isRecord(body) && typeof body.event === "string" ? body.event : "unknown";
    await recordEventStatement(db, eventId, type, "ignored", deps.now()).run();
    return json({ outcome: "ignored" });
  } catch (error) {
    log(`webhook ${eventId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return json({ error: "unavailable" }, 500);
  }
}
