import { describe, expect, it } from "vitest";
import {
  ENTRY_PREFIX, backoffMs, discardEntry, dueEntries, listEntries, pruneResults, readResult, resolvePath, retryEntry, runDue, saveEntry,
  type QueueEntry, type QueueStore, type SendFailure,
} from "./queue-core";

function memoryStore(): QueueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => { data.set(k, v); }, remove: (k) => { data.delete(k); }, keys: () => [...data.keys()] };
}
let seq = 0;
function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  seq++;
  return {
    id: `e${String(seq).padStart(3, "0")}`, userId: "u", generation: "g1", method: "POST", path: "/api/orders/o1/items", body: "{}", label: "Add items",
    lane: "o1", createdAt: seq, status: "pending", attempts: 0, lastAttemptAt: null, nextAttemptAt: 0, ...over,
  };
}
const fail = (status?: number, message = "Could not reach the server"): SendFailure => ({ ...(status === undefined ? {} : { status }), message });

describe("offline queue core", () => {
  it("sends each lane in order and never lets one order hold up another", async () => {
    const store = memoryStore();
    const a1 = entry({ lane: "o1" }), a2 = entry({ lane: "o1" }), b1 = entry({ lane: "o2", path: "/api/orders/o2/items" });
    [a1, a2, b1].forEach((e) => saveEntry(store, e));
    expect(dueEntries(store, "u", 0).map((e) => e.id)).toEqual([a1.id, b1.id]);
    const sent: string[] = [];
    // o1 cannot reach the hub; o2 still goes.
    await runDue({ store, now: () => 1000, random: () => 0.5, send: async (_m, path) => { sent.push(path); if (path.includes("o1")) throw fail(); return { ok: true }; } }, "u", "g1");
    expect(sent).toEqual(["/api/orders/o1/items", "/api/orders/o2/items"]);
    expect(readResult(store, b1.id)).toMatchObject({ status: "done", value: { ok: true } });
    const left = listEntries(store, "u");
    expect(left.map((e) => e.id)).toEqual([a1.id, a2.id]);
    expect(left[0]).toMatchObject({ attempts: 1, lastAttemptAt: 1000, nextAttemptAt: 2000, lastError: "Could not reach the server" });
    // Backing off: nothing is due before the next attempt time.
    expect(dueEntries(store, "u", 1999)).toEqual([]);
    expect(dueEntries(store, "u", 2000).map((e) => e.id)).toEqual([a1.id]);
  });

  it("backs off 1 s, 2 s, 4 s … up to 30 s with jitter", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMs(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffMs(1, () => 0)).toBe(750);
    expect(backoffMs(1, () => 1)).toBe(1250);
  });

  it("stops a refused request for review, along with what waits for it, and retries or discards on request", async () => {
    const store = memoryStore();
    const bill = entry({ path: "/api/orders/o1/bill", label: "Issue bill" });
    const pay = entry({ path: "/api/bills/{after:bill.id}/settle", label: "Take payment", after: bill.id });
    saveEntry(store, bill); saveEntry(store, pay);
    await runDue({ store, now: () => 5, random: () => 0.5, send: async () => { throw fail(409, "Order changed; review a fresh bill preview"); } }, "u", "g1");
    const [stopped, waiting] = listEntries(store, "u");
    expect(stopped).toMatchObject({ status: "attention", lastError: "Order changed; review a fresh bill preview", attempts: 1 });
    expect(waiting).toMatchObject({ status: "attention", lastError: "An earlier step needs attention first." });
    expect(dueEntries(store, "u", 100)).toEqual([]);

    retryEntry(store, bill.id, 10);
    expect(listEntries(store, "u").map((e) => e.status)).toEqual(["pending", "pending"]);
    discardEntry(store, bill.id, 20);
    expect(readResult(store, bill.id)).toMatchObject({ status: "discarded" });
    expect(listEntries(store, "u")).toEqual([expect.objectContaining({ id: pay.id, status: "attention", lastError: "An earlier step was discarded." })]);
  });

  it("chains steps: payment waits for the bill and uses its id, even across a reload", async () => {
    const store = memoryStore();
    const bill = entry({ path: "/api/orders/o1/bill", label: "Issue bill" });
    const pay = entry({ path: "/api/bills/{after:bill.id}/settle", label: "Take payment", after: bill.id });
    saveEntry(store, bill); saveEntry(store, pay);
    const sent: string[] = [];
    const send = async (_m: string, path: string) => { sent.push(path); return path.endsWith("/bill") ? { bill: { id: "b 7" } } : { paid: true }; };
    await runDue({ store, now: () => 1, random: () => 0.5, send }, "u", "g1");
    // A "reload": only storage survives, and the next run finishes the chain.
    await runDue({ store, now: () => 2, random: () => 0.5, send }, "u", "g1");
    expect(sent).toEqual(["/api/orders/o1/bill", "/api/bills/b%207/settle"]);
    expect(readResult(store, pay.id)).toMatchObject({ status: "done", value: { paid: true } });
    expect(listEntries(store, "u")).toEqual([]);
    expect(() => resolvePath("/api/bills/{after:bill.id}/settle", { order: {} })).toThrow(/bill.id/);
  });

  it("never sends the same entry twice when two windows run at once", async () => {
    const store = memoryStore();
    const one = entry();
    saveEntry(store, one);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { store, now: () => 1, random: () => 0.5, send: async () => { calls++; await gate; return { ok: true }; } };
    const first = runDue(slow, "u", "g1");
    // A second window reading after the first finished does not resend.
    release(); await first;
    await runDue(slow, "u", "g1");
    expect(calls).toBe(1);
    expect(readResult(store, one.id)?.status).toBe("done");
  });

  it("clears exactly the cart rows a punch carried, and keeps actions from an earlier restore for review", async () => {
    const store = memoryStore();
    store.set("masalapos.draft.u.o1", JSON.stringify([{ clientRef: "r1" }, { clientRef: "r2" }, { clientRef: "r3" }]));
    const punch = entry({ body: JSON.stringify({ items: [{ clientRef: "r1" }, { clientRef: "r2" }] }), draftKey: "masalapos.draft.u.o1" });
    const old = entry({ lane: "o9", generation: "g0" });
    saveEntry(store, punch); saveEntry(store, old);
    await runDue({ store, now: () => 1, random: () => 0.5, send: async () => ({ ok: true }) }, "u", "g1");
    expect(JSON.parse(store.get("masalapos.draft.u.o1")!)).toEqual([{ clientRef: "r3" }]);
    expect(listEntries(store, "u")).toEqual([expect.objectContaining({ id: old.id, status: "attention" })]);
  });

  it("drops result records after a day and ignores other people's entries", () => {
    const store = memoryStore();
    store.set("masalapos.queue-result.v2.x", JSON.stringify({ id: "x", status: "done", at: 0 }));
    store.set("masalapos.queue-result.v2.y", JSON.stringify({ id: "y", status: "done", at: 86_000_000 }));
    pruneResults(store, 86_400_001);
    expect(store.keys()).toEqual(["masalapos.queue-result.v2.y"]);
    saveEntry(store, entry({ userId: "someone-else" }));
    expect(listEntries(store, "u")).toEqual([]);
    expect(store.keys().some((k) => k.startsWith(ENTRY_PREFIX))).toBe(true);
  });
});
