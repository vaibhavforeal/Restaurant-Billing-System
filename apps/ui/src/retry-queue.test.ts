import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { discardRequest, enqueueRequest, outcomeOrSaved, queuedRequests, reliablePost, retryRequest, startQueue } from "./retry-queue";

vi.mock("./api", () => ({
  apiFetch: vi.fn(),
  session: { token: "token" },
  ApiError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));

let stop: (() => void) | undefined;
let values: Map<string, string>;
beforeEach(() => {
  values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { alert: () => {} }));
  vi.stubGlobal("navigator", {});
  vi.clearAllMocks();
  // The hub is unreachable unless a test says otherwise.
  vi.mocked(apiFetch).mockRejectedValue(new TypeError("Failed to fetch"));
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); });

/** An action the hub refused, saved as the queue keeps it, waiting for someone to retry or discard it. */
function saveRefused(id: string, path: string, body: unknown, error: string) {
  values.set(`masalapos.queue.v2.${id}`, JSON.stringify({
    id, userId: "cashier", generation: "current", method: "POST", path, body: JSON.stringify(body), label: "Bill", lane: "order-3",
    createdAt: 1, status: "attention", attempts: 1, lastAttemptAt: 1, nextAttemptAt: 0, lastError: error,
  }));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("offline queue in the browser", () => {
  it("rejects an empty kitchen send before saving it or calling the server", async () => {
    values.set("masalapos.generation", "current");
    stop = startQueue("cashier");
    await expect(reliablePost("/api/orders/order-1/send", { clientRef: "request-1", itemIds: [] }, "Send to kitchen"))
      .rejects.toThrow("No items are waiting for a kitchen ticket.");
    expect(queuedRequests()).toEqual([]);
  });

  it("keeps actions saved while the hub is unreachable and lets them be queued for the order's lane", async () => {
    values.set("masalapos.generation", "current");
    stop = startQueue("cashier");
    const punch = enqueueRequest({ path: "/api/orders/order-1/items", body: { items: [{ clientRef: "r1" }] }, label: "Add items" });
    const captain = enqueueRequest({ method: "PATCH", path: "/api/orders/order-1/captain", body: { captainId: "w1" }, label: "Change captain" });
    punch.done.catch(() => {}); captain.done.catch(() => {});
    await flush();
    expect(queuedRequests().map((e) => [e.label, e.lane, e.status])).toEqual([["Add items", "order-1", "pending"], ["Change captain", "order-1", "pending"]]);
    // A double tap is one action; something not safe to repeat is never queued.
    await expect(reliablePost("/api/orders/order-1/items", { items: [{ clientRef: "r1" }] }, "Add items")).rejects.toThrow(/needs to finish/);
    await expect(reliablePost("/api/bills/b1/print", {}, "Print")).rejects.toThrow("This action cannot be queued");
  });

  it("tells the caller the outcome even when another window sent the action", async () => {
    values.set("masalapos.generation", "current");
    stop = startQueue("cashier");
    const { id, done } = enqueueRequest<{ ok: boolean }>({ path: "/api/orders/order-1/send", body: { clientRef: "k1", itemIds: ["i1"] }, label: "Send to kitchen" });
    await flush();
    // Another window finishes it and leaves the result record.
    values.delete(`masalapos.queue.v2.${id}`);
    values.set(`masalapos.queue-result.v2.${id}`, JSON.stringify({ id, status: "done", value: { ok: true }, at: Date.now() }));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: `masalapos.queue-result.v2.${id}` }));
    await expect(done).resolves.toEqual({ ok: true });
  });

  it("retries a stopped action and discards one on request", async () => {
    values.set("masalapos.generation", "current");
    saveRefused("refused", "/api/orders/order-3/bill", { clientRef: "b1" }, "Order changed; review a fresh bill preview");
    stop = startQueue("cashier");
    expect(queuedRequests()[0]).toMatchObject({ id: "refused", status: "attention", error: "Order changed; review a fresh bill preview" });
    retryRequest("refused");
    expect(queuedRequests()[0]).toMatchObject({ status: "pending" });
    discardRequest("refused");
    expect(queuedRequests()).toEqual([]);
    expect(JSON.parse(values.get("masalapos.queue-result.v2.refused")!)).toMatchObject({ status: "discarded" });
  });

  it("tells the screen an action is saved once the hub cannot be reached, and gives the reply when it can", async () => {
    values.set("masalapos.generation", "current");
    stop = startQueue("cashier");
    await expect(outcomeOrSaved(enqueueRequest({ path: "/api/orders/order-1/cancel", body: {}, label: "Cancel order" }), 60_000)).resolves.toEqual({ saved: true });
    vi.mocked(apiFetch).mockImplementation(async (path: string) => path === "/api/system/generation" ? { generation: "current" } : { ok: path });
    await expect(outcomeOrSaved(enqueueRequest({ path: "/api/orders/order-2/cancel", body: {}, label: "Cancel order" }), 60_000))
      .resolves.toEqual({ saved: false, value: { ok: "/api/orders/order-2/cancel" } });
  });

  it("does not call an action saved offline while another window holds the lock and is sending it", async () => {
    values.set("masalapos.generation", "current");
    // Another window holds the queue lock, so this window's check-in never runs.
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<void>) => { await callback(null); } } });
    stop = startQueue("cashier");
    let settled = false;
    void outcomeOrSaved(enqueueRequest({ path: "/api/orders/order-1/cancel", body: {}, label: "Cancel order" }), 60_000).then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
  });

  it("finishes a saved bill and its payment after a reload, paying the bill the hub issued", async () => {
    values.set("masalapos.generation", "current");
    stop = startQueue("cashier");
    const bill = enqueueRequest({ path: "/api/orders/order-1/bill", body: { clientRef: "b1" }, label: "Issue bill" });
    const pay = enqueueRequest({ path: "/api/bills/{after:bill.id}/settle", after: bill.id, lane: "order-1", body: { clientRef: "p1", payments: [] }, label: "Record payment" });
    bill.done.catch(() => {}); pay.done.catch(() => {});
    await flush();
    stop(); // the page reloads while offline
    const sent: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === "/api/system/generation") return { generation: "current" };
      sent.push(path);
      return { bill: { id: "bill-9" } };
    });
    stop = startQueue("cashier");
    await vi.waitFor(() => expect(queuedRequests()).toEqual([]), { timeout: 5000 });
    expect(sent).toEqual(["/api/orders/order-1/bill", "/api/bills/bill-9/settle"]);
  });
});
