import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { queuedRequests, reliablePost, startQueue, type QueuedRequest } from "./retry-queue";

vi.mock("./api", () => ({ apiFetch: vi.fn(), session: { token: null }, ApiError: class extends Error {} }));

let stop: (() => void) | undefined;
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.clearAllMocks();
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); });

function save(id: string, changes: Partial<QueuedRequest> = {}) {
  const entry: QueuedRequest = {
    id, userId: "cashier", generation: "current", path: "/api/orders/order-1/send",
    body: JSON.stringify({ clientRef: "request-1", itemIds: [] }), label: "Send to kitchen",
    createdAt: 1, error: "Too small: expected array to have >=1 items", ...changes,
  };
  localStorage.setItem(`forkflow.queue.v1.${id}`, JSON.stringify(entry));
}

describe("empty KOT requests", () => {
  it("rejects an empty send before saving it or calling the server", async () => {
    stop = startQueue("cashier");
    localStorage.setItem("forkflow.generation", "current");
    await expect(reliablePost("/api/orders/order-1/send", { clientRef: "request-1", itemIds: [] }, "Send to kitchen"))
      .rejects.toThrow("No items are waiting for a kitchen ticket.");
    expect(queuedRequests()).toEqual([]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("clears only rejected empty KOTs for the signed-in user and keeps the cart", () => {
    save("empty-1"); save("empty-2");
    save("other-user", { userId: "waiter" });
    save("real-kot", { body: JSON.stringify({ clientRef: "request-2", itemIds: ["item-1"] }) });
    save("bill", { path: "/api/orders/order-1/bill" });
    save("damaged", { body: "not json" });
    localStorage.setItem("forkflow.draft.cashier.order-1", '[{"clientRef":"cart-1","qty":2}]');
    stop = startQueue("cashier");
    expect(queuedRequests().map(entry => entry.id)).toEqual(["bill", "damaged", "real-kot"]);
    expect(queuedRequests("waiter").map(entry => entry.id)).toEqual(["other-user"]);
    expect(localStorage.getItem("forkflow.draft.cashier.order-1")).toBe('[{"clientRef":"cart-1","qty":2}]');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps unacknowledged actions for reconciliation", () => {
    save("unacknowledged", { error: "" });
    stop = startQueue("cashier");
    expect(queuedRequests().map(entry => entry.id)).toEqual(["unacknowledged"]);
  });
});
