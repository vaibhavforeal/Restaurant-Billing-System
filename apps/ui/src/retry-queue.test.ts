import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { discardRequest, enqueueRequest, queuedRequests, reliablePost, retryRequest, startQueue } from "./retry-queue";

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

function saveV1(id: string, changes: Record<string, unknown> = {}) {
  values.set(`forkflow.queue.v1.${id}`, JSON.stringify({
    id, userId: "cashier", generation: "current", path: "/api/orders/order-1/send",
    body: JSON.stringify({ clientRef: "request-1", itemIds: [] }), label: "Send to kitchen",
    createdAt: 1, error: "Too small: expected array to have >=1 items", ...changes,
  }));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("offline queue in the browser", () => {
  it("rejects an empty kitchen send before saving it or calling the server", async () => {
    values.set("forkflow.generation", "current");
    stop = startQueue("cashier");
    await expect(reliablePost("/api/orders/order-1/send", { clientRef: "request-1", itemIds: [] }, "Send to kitchen"))
      .rejects.toThrow("No items are waiting for a kitchen ticket.");
    expect(queuedRequests()).toEqual([]);
  });

  it("moves actions saved by the old queue across, dropping only refused empty kitchen sends", () => {
    saveV1("empty-1"); saveV1("empty-2");
    saveV1("other-user", { userId: "waiter" });
    saveV1("real-kot", { body: JSON.stringify({ clientRef: "request-2", itemIds: ["item-1"] }) });
    saveV1("bill", { path: "/api/orders/order-1/bill" });
    saveV1("unacknowledged", { error: "", path: "/api/orders/order-2/items", body: JSON.stringify({ items: [] }) });
    values.set("forkflow.draft.cashier.order-1", '[{"clientRef":"cart-1","qty":2}]');
    stop = startQueue("cashier");
    expect(queuedRequests().map((e) => [e.id, e.status, e.lane])).toEqual([
      ["bill", "attention", "order-1"], ["real-kot", "attention", "order-1"], ["unacknowledged", "pending", "order-2"],
    ]);
    expect(queuedRequests("waiter").map((e) => e.id)).toEqual(["other-user"]);
    expect([...values.keys()].some((k) => k.startsWith("forkflow.queue.v1."))).toBe(false);
    expect(values.get("forkflow.draft.cashier.order-1")).toBe('[{"clientRef":"cart-1","qty":2}]');
  });

  it("keeps actions saved while the hub is unreachable and lets them be queued for the order's lane", async () => {
    values.set("forkflow.generation", "current");
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
    values.set("forkflow.generation", "current");
    stop = startQueue("cashier");
    const { id, done } = enqueueRequest<{ ok: boolean }>({ path: "/api/orders/order-1/send", body: { clientRef: "k1", itemIds: ["i1"] }, label: "Send to kitchen" });
    await flush();
    // Another window finishes it and leaves the result record.
    values.delete(`forkflow.queue.v2.${id}`);
    values.set(`forkflow.queue-result.v2.${id}`, JSON.stringify({ id, status: "done", value: { ok: true }, at: Date.now() }));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: `forkflow.queue-result.v2.${id}` }));
    await expect(done).resolves.toEqual({ ok: true });
  });

  it("retries a stopped action and discards one on request", async () => {
    values.set("forkflow.generation", "current");
    saveV1("refused", { path: "/api/orders/order-3/bill", body: JSON.stringify({ clientRef: "b1" }), error: "Order changed; review a fresh bill preview" });
    stop = startQueue("cashier");
    expect(queuedRequests()[0]).toMatchObject({ id: "refused", status: "attention", error: "Order changed; review a fresh bill preview" });
    retryRequest("refused");
    expect(queuedRequests()[0]).toMatchObject({ status: "pending" });
    discardRequest("refused");
    expect(queuedRequests()).toEqual([]);
    expect(JSON.parse(values.get("forkflow.queue-result.v2.refused")!)).toMatchObject({ status: "discarded" });
  });
});
