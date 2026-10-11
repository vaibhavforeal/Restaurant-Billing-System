import { describe, expect, it } from "vitest";
import { classifyPrintOutcome, matchingCompletions, parseCompletion, selectCompletion, storeCompletion, sweepExpiredCompletions, type QueueCompletion } from "./queue-completion";

const identity = { version: 1 as const, requestId: "r1", attemptId: "a1", userId: "cashier", generation: "g1", path: "/api/orders/o1/send", body: '{"clientRef":"c1","itemIds":["i1"]}', completedAt: 100 };
const success: QueueCompletion = { ...identity, outcome: "success", response: { kots: [{ id: "k1" }] }, printOutcome: "unknown" };

function storage() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (n: number) => [...values.keys()][n] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("queue completion evidence", () => {
  it("rejects malformed and mismatched records instead of accepting another actor or body", () => {
    const s = storage();
    s.setItem("forkflow.queue-result.v1.r1.a1", JSON.stringify(success));
    s.setItem("forkflow.queue-result.v1.r1.bad", "{");
    s.setItem("forkflow.queue-result.v1.r1.other", JSON.stringify({ ...success, attemptId: "other", body: "{}" }));
    expect(parseCompletion("{}", "forkflow.queue-result.v1.r1.a1")).toBeNull();
    expect(matchingCompletions(s, identity)).toEqual([success]);
    expect(matchingCompletions(s, { ...identity, userId: "other" })).toEqual([]);
  });

  it("prefers original print evidence over a replay without replacing the response", () => {
    const reported: QueueCompletion = { ...success, attemptId: "a2", completedAt: 101, response: { kots: [{ id: "k1" }], printErrors: ["offline"] }, printOutcome: "reported" };
    expect(selectCompletion([success, reported])).toEqual(reported);
    expect(classifyPrintOutcome(identity.path, JSON.parse(identity.body), (reported as any).response)).toBe("reported");
    expect(classifyPrintOutcome(identity.path, JSON.parse(identity.body), (success as any).response)).toBe("unknown");
    expect(classifyPrintOutcome("/api/orders/o1/bill", { printerId: null }, { bill: {}, job: null })).toBe("not_requested");
    expect(classifyPrintOutcome("/api/orders/o1/bill", { printerId: "p1" }, { bill: {}, job: null, printError: null })).toBe("unknown");
  });

  it("retains immutable attempts and evicts whole old request groups", () => {
    const s = storage();
    storeCompletion(s, success, new Set(), 1000);
    storeCompletion(s, { ...success, attemptId: "a2", completedAt: 101 }, new Set(), 1000);
    expect(s.values.size).toBe(2);
    expect(() => storeCompletion(s, { ...success, response: {} }, new Set(), 1000)).toThrow();
    storeCompletion(s, { ...success, requestId: "r2", attemptId: "a3", completedAt: 26 * 60 * 60 * 1000 }, new Set(), 26 * 60 * 60 * 1000);
    expect([...s.values.keys()]).toEqual(["forkflow.queue-result.v1.r2.a3"]);
  });

  it("measures serialized UTF-8 bytes and keeps every pending group protected", () => {
    const s = storage();
    const large: QueueCompletion = { ...success, response: { text: "₹".repeat(200000) } };
    storeCompletion(s, large, new Set(["r1"]), 1000);
    expect(() => storeCompletion(s, { ...large, requestId: "r2" }, new Set(["r1", "r2"]), 1000)).toThrow(/capacity/);
    expect(s.values.size).toBe(1);
  });

  it("bounds request groups at 100 without splitting multiple attempts", () => {
    const s = storage();
    storeCompletion(s, success, new Set(), 1000);
    storeCompletion(s, { ...success, attemptId: "a2" }, new Set(), 1000);
    for (let n = 2; n <= 101; n++) storeCompletion(s, { ...success, requestId: `r${n}`, completedAt: n + 100 }, new Set(), 1000);
    expect(s.values.size).toBe(100); expect([...s.values.keys()].some(key => key.startsWith("forkflow.queue-result.v1.r1."))).toBe(false);
  });

  it("rejects invalid timestamps, status values, primitive payloads and credential metadata", () => {
    const key = "forkflow.queue-result.v1.r1.a1";
    for (const value of [null, 42, { ...success, completedAt: -1 }, { ...success, token: "secret" }, { ...identity, outcome: "rejected", status: 200, message: "no" }]) expect(parseCompletion(JSON.stringify(value), key)).toBeNull();
  });

  it("sweeps expired whole groups while retaining pending and recently active groups", () => {
    const s = storage(), now = 26 * 60 * 60 * 1000;
    s.setItem("forkflow.queue-result.v1.r1.a1", JSON.stringify(success));
    s.setItem("forkflow.queue-result.v1.r1.a2", JSON.stringify({ ...success, attemptId: "a2", completedAt: 101 }));
    s.setItem("forkflow.queue-result.v1.r2.a1", JSON.stringify({ ...success, requestId: "r2" }));
    s.setItem("forkflow.queue-result.v1.r3.a1", JSON.stringify({ ...success, requestId: "r3" }));
    s.setItem("forkflow.queue-result.v1.r3.a2", JSON.stringify({ ...success, requestId: "r3", attemptId: "a2", completedAt: now - 100 }));
    sweepExpiredCompletions(s, new Set(["r2"]), now);
    expect([...s.values.keys()].sort()).toEqual([
      "forkflow.queue-result.v1.r2.a1", "forkflow.queue-result.v1.r3.a1", "forkflow.queue-result.v1.r3.a2",
    ]);
  });
});
