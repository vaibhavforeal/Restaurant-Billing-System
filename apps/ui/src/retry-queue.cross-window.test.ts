import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The audit reproduction uses real modules in distinct windows, shared storage,
// and explicitly released network promises (no sleeps or wall-clock races).
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture() {
  const values = new Map<string, string>([["forkflow.generation", "g1"]]);
  let fault = (_operation: string, _key: string) => false;
  const storage = {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (fault("set", key)) throw new Error("quota"); values.set(key, value); },
    removeItem: (key: string) => { if (fault("remove", key)) throw new Error("storage unavailable"); values.delete(key); },
  };
  function tab(name: string) {
    const generation = deferred<{ generation: string }>();
    const requests: Array<ReturnType<typeof deferred<unknown>>> = [];
    const timers: Array<() => void> = [];
    const win = Object.assign(new EventTarget(), { alert() {} });
    let first = true, serial = 0, serverGeneration = "g1";
    class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
    const api = { session: { token: "token" as string | null }, ApiError, apiFetch: async (path: string) => {
      if (path === "/api/system/generation") { if (first) { first = false; return generation.promise; } return { generation: serverGeneration }; }
      const request = deferred<unknown>(); requests.push(request); return request.promise;
    } };
    const context = createContext({ localStorage: storage, window: win, location: { reload() {} },
      setInterval: (callback: () => void) => { timers.push(callback); return 1; }, clearInterval() {},
      CustomEvent: class extends Event { detail: unknown; constructor(type: string, options: { detail: unknown }) { super(type); this.detail = options.detail; } },
      Date, Error, Set, Map, JSON, TextEncoder,
    });
    const cache = new Map<string, unknown>();
    function load(module: string): unknown {
      if (module === "./api") return api;
      if (module === "./uuid") return { uuid: () => `${name}-${++serial}` };
      if (cache.has(module)) return cache.get(module);
      const exports = {};
      cache.set(module, exports);
      const source = module === "./retry-queue" && process.env.QUEUE_BASELINE ? process.env.QUEUE_BASELINE : new URL(`${module}.ts`, import.meta.url);
      const code = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      runInContext(`(function(exports,require){${code}\n})`, context)(exports, load);
      return exports;
    }
    const queue = load("./retry-queue") as typeof import("./retry-queue");
    const stop = queue.startQueue("cashier");
    return { queue, win, requests, api, stop, ready: (g = "g1") => { serverGeneration = g; generation.resolve({ generation: g }); }, tick: () => timers[0]!(), restore: () => { serverGeneration = "g2"; }, storage: () => win.dispatchEvent(new Event("storage")) };
  }
  return { values, tab, setFault: (next: typeof fault) => { fault = next; } };
}
function observe(promise: Promise<unknown>) {
  const state = { status: "pending", value: undefined as any, error: undefined as any, continuations: 0, locked: true };
  void promise.then(value => { state.status = "fulfilled"; state.value = value; state.continuations++; }, error => { state.status = "rejected"; state.error = error; }).finally(() => { state.locked = false; });
  return state;
}
const items = { items: [{ clientRef: "cart-1", qty: 1 }] };
const result = { order: { id: "order-1" } };

describe("cross-window queued action completion", () => {
  it.each(["event", "tick"])("settles the paused producer from another worker using %s", async mode => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b");
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    b.ready(); await flush(); b.requests[0]!.resolve(result); await flush();
    if (mode === "event") a.storage(); else a.tick();
    await flush(); a.ready(); await flush();
    expect(state.status).toBe("fulfilled"); expect(state.locked).toBe(false);
    expect(state.value.order.id).toBe("order-1"); expect(state.continuations).toBe(1);
    expect(a.requests).toHaveLength(0); expect(a.queue.queuedRequests()).toHaveLength(0);
    a.stop(); b.stop();
  });

  it("rejects disappearance without acknowledgement and blocks a fresh duplicate", async () => {
    const f = fixture(), a = f.tab("a");
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    f.values.delete("forkflow.queue.v1.a-1"); a.storage(); await flush();
    expect(state.status).toBe("rejected"); expect(state.error.name).toBe("QueueReconciliationRequiredError");
    expect(state.locked).toBe(false); expect([...f.values.keys()].some(k => k.startsWith("forkflow.queue-recovery.v1."))).toBe(true);
    await expect(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch")).rejects.toThrow(/review/i);
    a.ready(); await flush(); expect(a.requests).toHaveLength(0); a.stop();
  });

  it.each(["original-first", "replay-first"])("retains per-attempt printing evidence (%s) without a second continuation", async order => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b");
    const feedback: any[] = []; a.win.addEventListener("forkflow:queue-feedback", (e: Event) => feedback.push((e as CustomEvent).detail));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/send", { clientRef: "kot", itemIds: ["i1"] }, "KOT"));
    a.ready(); b.ready(); await flush();
    const original = { kots: [{ id: "k1" }], printErrors: ["Printer offline"] }, replay = { kots: [{ id: "k1" }] };
    const first = order === "original-first" ? a : b, second = first === a ? b : a;
    first.requests[0]!.resolve(first === a ? original : replay); await flush(); a.storage(); await flush();
    expect(state.status).toBe("fulfilled"); expect(state.value.queueMeta.printOutcome).toBe(first === a ? "reported" : "unknown");
    second.requests[0]!.resolve(second === a ? original : replay); await flush(); a.storage(); a.tick(); await flush();
    expect(state.continuations).toBe(1); expect(a.requests).toHaveLength(1); expect(b.requests).toHaveLength(1);
    const completions = [...f.values.entries()].filter(([k]) => k.startsWith("forkflow.queue-result.v1.")).map(([, v]) => JSON.parse(v));
    expect(completions).toHaveLength(2); expect(completions.some(c => c.response?.printErrors?.[0] === "Printer offline")).toBe(true);
    if (order === "replay-first") expect(feedback.some(e => e.requestId === "a-1" && e.printOutcome === "reported")).toBe(true);
    a.stop(); b.stop();
  });

  it.each(["completion", "draft", "removal"])("keeps successful evidence after %s storage failure and never reposts", async point => {
    const f = fixture(), a = f.tab("a");
    const key = "forkflow.draft.cashier.order-1"; f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }, { clientRef: "new-row" }]));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    a.ready(); await flush();
    f.setFault((op, k) => point === "completion" ? op === "set" && k.startsWith("forkflow.queue-result.v1.") : point === "draft" ? op === "set" && k === key : op === "remove" && k.startsWith("forkflow.queue.v1."));
    a.requests[0]!.resolve(result); await flush();
    expect(state.status).toBe("rejected"); expect(state.error.name).toBe("QueueReconciliationRequiredError");
    expect(a.queue.queuedRequests()).toHaveLength(1);
    f.setFault(() => false); a.tick(); await flush();
    expect(a.requests).toHaveLength(1); expect(a.queue.queuedRequests()).toHaveLength(0);
    expect(JSON.parse(f.values.get(key)!)).toEqual([{ clientRef: "new-row" }]);
    expect(state.continuations).toBe(0); a.stop();
  });

  it("fences a POST response after logout and a new session", async () => {
    const f = fixture(), a = f.tab("a");
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    a.ready(); await flush(); a.stop(); a.api.session.token = "new-token";
    const stop = a.queue.startQueue("other-staff");
    a.requests[0]!.resolve(result); await flush();
    expect(state.status).toBe("rejected"); expect(f.values.has("forkflow.queue.v1.a-1")).toBe(true);
    expect([...f.values.keys()].some(k => k.startsWith("forkflow.queue-result.v1."))).toBe(false); stop();
  });

  it("notifies a settled producer when another worker later reports print failure", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b");
    const feedback: any[] = []; a.win.addEventListener("forkflow:queue-feedback", (e: Event) => feedback.push((e as CustomEvent).detail));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/bill", { printerId: "p1" }, "Bill"));
    a.ready(); b.ready(); await flush();
    a.requests[0]!.resolve({ bill: { id: "bill-1" }, job: null, printError: null }); await flush();
    b.requests[0]!.resolve({ bill: { id: "bill-1" }, job: null, printError: "offline" }); await flush(); a.storage(); await flush();
    expect(feedback).toHaveLength(1); expect(feedback[0].requestId).toBe("a-1");
    expect(feedback[0].response.printError).toBe("offline"); expect(state.continuations).toBe(1); a.stop(); b.stop();
  });

  it("reviews a late success after another worker rejects without continuing checkout", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b"), reviews: any[] = [];
    a.win.addEventListener("forkflow:queue-review", (e: Event) => reviews.push((e as CustomEvent).detail));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    a.ready(); b.ready(); await flush();
    b.requests[0]!.reject(new b.api.ApiError(409, "conflict")); await flush(); a.storage(); await flush();
    expect(state.status).toBe("rejected"); a.requests[0]!.resolve(result); await flush();
    expect(reviews).toHaveLength(1); expect(state.continuations).toBe(0); a.stop(); b.stop();
  });

  it("does not repost recovery after a worker loses volatile success evidence", async () => {
    const f = fixture(), a = f.tab("a");
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    a.ready(); await flush(); f.setFault((op, key) => op === "set" && key.startsWith("forkflow.queue-result.v1."));
    a.requests[0]!.resolve(result); await flush(); expect(state.status).toBe("rejected"); a.stop();
    f.setFault(() => false); const b = f.tab("b"); b.ready(); await flush();
    expect(b.requests).toHaveLength(0); expect(b.queue.recoveryRequests()).toHaveLength(1); b.stop();
  });

  it("retains pending and draft evidence if generation archival fails", async () => {
    const f = fixture(), a = f.tab("a");
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    f.values.set("forkflow.draft.cashier.order-1", "[]");
    f.setFault((op, key) => op === "set" && key.startsWith("forkflow.recovery-archive.")); a.ready("g2"); await flush();
    expect(a.requests).toHaveLength(0); expect(f.values.get("forkflow.generation")).toBe("g1");
    expect(f.values.has("forkflow.queue.v1.a-1")).toBe(true); expect(f.values.has("forkflow.draft.cashier.order-1")).toBe(true);
    expect(state.status).toBe("pending"); f.setFault(() => false); a.tick(); await flush();
    expect(state.status).toBe("rejected"); expect(f.values.has("forkflow.queue.v1.a-1")).toBe(false); a.stop();
  });

  it.each(["rejected", "dismissed"])("removes persisted %s work before notifying the producer", async outcome => {
    const f = fixture(), a = f.tab("a"); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    f.values.set("forkflow.queue-result.v1.a-1.other", JSON.stringify({ version: 1, requestId: "a-1", attemptId: "other", userId: "cashier", generation: "g1", path: "/api/orders/order-1/items", body: JSON.stringify(items), completedAt: Date.now(), outcome, status: 409, message: "conflict" }));
    a.storage(); await flush(); expect(state.status).toBe("rejected"); expect(a.queue.queuedRequests()).toHaveLength(0); a.ready(); await flush(); expect(a.requests).toHaveLength(0); a.stop();
  });

  it("recovers a worker crash after completion persistence without another POST", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b");
    const key = "forkflow.draft.cashier.order-1"; f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }]));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    b.ready(); await flush(); f.setFault((op, k) => op === "remove" && k.startsWith("forkflow.queue.v1."));
    b.requests[0]!.resolve(result); await flush(); b.stop(); f.setFault(() => false);
    // Simulate a crash immediately after persistence, before the worker could save recovery.
    f.values.delete("forkflow.queue-recovery.v1.a-1");
    a.storage(); await flush(); a.ready(); await flush();
    expect(state.status).toBe("fulfilled"); expect(state.continuations).toBe(1); expect(a.requests).toHaveLength(0); expect(f.values.get(key)).toBe("[]"); a.stop();
  });

  it("expires a suspended producer response into review without a replay", async () => {
    const f = fixture(), a = f.tab("a"); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    f.values.delete("forkflow.queue.v1.a-1");
    f.values.set("forkflow.queue-result.v1.a-1.other", JSON.stringify({ version: 1, requestId: "a-1", attemptId: "other", userId: "cashier", generation: "g1", path: "/api/orders/order-1/items", body: JSON.stringify(items), completedAt: Date.now() - 25 * 60 * 60 * 1000, outcome: "success", response: result, printOutcome: "not_requested" }));
    a.tick(); await flush(); a.ready(); await flush();
    expect(state.error.name).toBe("QueueReconciliationRequiredError"); expect(a.requests).toHaveLength(0); a.stop();
  });

  it("keeps a transient lost response queued with the exact serialized request", async () => {
    const f = fixture(), a = f.tab("a"); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    a.ready(); await flush(); a.requests[0]!.reject(new TypeError("lost response")); await flush();
    expect(state.status).toBe("pending"); expect(a.queue.queuedRequests()[0]?.body).toBe(JSON.stringify(items));
    a.tick(); await flush(); expect(a.requests).toHaveLength(2); a.requests[1]!.resolve(result); await flush();
    expect(state.continuations).toBe(1); a.stop();
  });

  it("preserves a terminal error when the worker cannot store it and never retries recovery", async () => {
    const f = fixture(), a = f.tab("a"); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    a.ready(); await flush(); f.setFault((op, key) => op === "set" && key.startsWith("forkflow.queue-result.v1."));
    a.requests[0]!.reject(new a.api.ApiError(409, "conflict", "conflict_code")); await flush();
    expect(state.error.name).toBe("QueueReconciliationRequiredError"); expect(a.queue.queuedRequests()).toHaveLength(1);
    f.setFault(() => false); a.tick(); await flush(); expect(a.requests).toHaveLength(1); a.stop();
  });

  it("does not use an old generation response to clean a restored draft", async () => {
    const f = fixture(), a = f.tab("a"); const key = "forkflow.draft.cashier.order-1";
    f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }])); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    a.ready(); await flush(); f.values.set("forkflow.generation", "g2"); a.requests[0]!.resolve(result); await flush();
    expect(f.values.get(key)).toBe(JSON.stringify([{ clientRef: "cart-1" }])); expect([...f.values.keys()].some(key => key.startsWith("forkflow.queue-result.v1."))).toBe(false);
    a.storage(); await flush(); expect(state.status).toBe("rejected"); a.stop();
  });

  it("fences a paused generation response after another window restores storage", async () => {
    const f = fixture(), a = f.tab("a");
    f.values.set("forkflow.generation", "g2"); f.values.set("forkflow.draft.cashier.restored", "[]");
    a.ready("g1"); await flush();
    expect(f.values.get("forkflow.generation")).toBe("g2"); expect(f.values.has("forkflow.draft.cashier.restored")).toBe(true); a.stop();
  });

  it("releases the producer when another worker exposes storage recovery", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b"); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    b.ready(); await flush(); f.setFault((op, key) => op === "set" && key.startsWith("forkflow.queue-result.v1."));
    b.requests[0]!.resolve(result); await flush(); a.storage(); await flush();
    expect(state.status).toBe("rejected"); expect(state.locked).toBe(false); expect(state.continuations).toBe(0); a.stop(); b.stop();
  });

  it("never replays an expired completion even when a crash left pending work", async () => {
    const f = fixture(), a = f.tab("a"); const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    f.values.set("forkflow.queue-result.v1.a-1.old", JSON.stringify({ version: 1, requestId: "a-1", attemptId: "old", userId: "cashier", generation: "g1", path: "/api/orders/order-1/items", body: JSON.stringify(items), completedAt: Date.now() - 25 * 60 * 60 * 1000, outcome: "success", response: result, printOutcome: "not_requested" }));
    a.ready(); await flush(); expect(state.status).toBe("rejected"); expect(a.requests).toHaveLength(0); a.stop();
  });

  it("suppresses late printing feedback when the producer token has changed", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b"), feedback: any[] = [];
    a.win.addEventListener("forkflow:queue-feedback", (e: Event) => feedback.push((e as CustomEvent).detail));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/send", { itemIds: ["i1"] }, "KOT"));
    a.ready(); b.ready(); await flush(); a.requests[0]!.resolve({ kots: [{ id: "k1" }] }); await flush();
    a.api.session.token = "replacement-token"; b.requests[0]!.resolve({ kots: [{ id: "k1" }], printErrors: ["offline"] }); await flush(); a.storage(); await flush();
    expect(state.continuations).toBe(1); expect(feedback).toHaveLength(0); a.stop(); b.stop();
  });

  it("does not continue after another window exposes a cleanup failure", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b"), key = "forkflow.draft.cashier.order-1";
    f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }]));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    b.ready(); await flush(); f.setFault((op, k) => op === "set" && k === key); b.requests[0]!.resolve(result); await flush();
    f.setFault(() => false); a.storage(); await flush();
    expect(state.status).toBe("rejected"); expect(state.continuations).toBe(0); a.ready(); await flush(); expect(a.requests).toHaveLength(0); a.stop(); b.stop();
  });

  it("cleans acknowledged draft rows when a failing worker selects a crashed worker success", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b"), key = "forkflow.draft.cashier.order-1";
    f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }, { clientRef: "new-row" }]));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    a.ready(); b.ready(); await flush();
    f.values.set("forkflow.queue-result.v1.a-1.crashed", JSON.stringify({ version: 1, requestId: "a-1", attemptId: "crashed", userId: "cashier", generation: "g1", path: "/api/orders/order-1/items", body: JSON.stringify(items), completedAt: Date.now(), outcome: "success", response: result, printOutcome: "not_requested" }));
    b.requests[0]!.reject(new b.api.ApiError(409, "late rejection")); await flush(); a.storage(); await flush();
    expect(state.status).toBe("fulfilled"); expect(state.continuations).toBe(1);
    expect(JSON.parse(f.values.get(key)!)).toEqual([{ clientRef: "new-row" }]);
    a.requests[0]!.resolve(result); await flush(); expect(state.continuations).toBe(1); a.stop(); b.stop();
  });

  it("cleans acknowledged draft rows when dismissal races a persisted success", async () => {
    const f = fixture(), a = f.tab("a"), key = "forkflow.draft.cashier.order-1";
    f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }, { clientRef: "new-row" }]));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    const pending = JSON.parse(f.values.get("forkflow.queue.v1.a-1")!);
    f.values.set("forkflow.queue.v1.a-1", JSON.stringify({ ...pending, error: "old failure" }));
    f.values.set("forkflow.queue-result.v1.a-1.crashed", JSON.stringify({ version: 1, requestId: "a-1", attemptId: "crashed", userId: "cashier", generation: "g1", path: "/api/orders/order-1/items", body: JSON.stringify(items), completedAt: Date.now(), outcome: "success", response: result, printOutcome: "not_requested" }));
    a.queue.discardRequest("a-1"); await flush();
    expect(state.status).toBe("fulfilled"); expect(state.continuations).toBe(1);
    expect(JSON.parse(f.values.get(key)!)).toEqual([{ clientRef: "new-row" }]);
    expect(a.queue.queuedRequests()).toHaveLength(0); a.stop();
  });

  it("refreshes current state once more after recovery receives a late successful outcome", async () => {
    const f = fixture(), a = f.tab("a"), reviews: any[] = [];
    a.win.addEventListener("forkflow:queue-review", (e: Event) => reviews.push((e as CustomEvent).detail));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch"));
    a.ready(); await flush(); f.values.delete("forkflow.queue.v1.a-1"); a.storage(); await flush();
    expect(state.status).toBe("rejected"); expect(reviews).toHaveLength(1);
    a.requests[0]!.resolve(result); await flush(); a.tick(); a.storage(); await flush();
    expect(reviews).toHaveLength(2); expect(reviews[1].requestId).toBe("a-1"); expect(state.continuations).toBe(0); expect(a.requests).toHaveLength(1); a.stop();
  });

  it("retains durable review after a cleanup failure and a fresh same-actor window", async () => {
    const f = fixture(), a = f.tab("a"), b = f.tab("b"), key = "forkflow.draft.cashier.order-1";
    f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }, { clientRef: "new-row" }]));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    b.ready(); await flush();
    f.setFault((op, storageKey) => op === "set" && storageKey === key);
    b.requests[0]!.resolve(result); await flush(); a.storage(); await flush();
    expect(state.status).toBe("rejected"); expect(b.queue.recoveryRequests()).toHaveLength(1);
    a.stop(); b.stop(); f.setFault(() => false);

    const c = f.tab("c"); c.ready(); await flush();
    expect(JSON.parse(f.values.get(key)!)).toEqual([{ clientRef: "new-row" }]);
    expect(c.queue.recoveryRequests()).toHaveLength(1);
    await expect(c.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key)).rejects.toThrow(/review/i);
    expect(c.requests).toHaveLength(0); expect(state.continuations).toBe(0); c.stop();
  });

  it("does not apply volatile success evidence after the session token changes", async () => {
    const f = fixture(), a = f.tab("a"), key = "forkflow.draft.cashier.order-1", acks: unknown[] = [];
    f.values.set(key, JSON.stringify([{ clientRef: "cart-1" }]));
    a.win.addEventListener("forkflow:ack", (event: Event) => acks.push(event));
    const state = observe(a.queue.reliablePost("/api/orders/order-1/items", items, "Punch", key));
    a.ready(); await flush();
    f.setFault((op, storageKey) => op === "set" && storageKey.startsWith("forkflow.queue-result.v1."));
    a.requests[0]!.resolve(result); await flush(); expect(state.status).toBe("rejected");
    a.api.session.token = "replacement-token"; f.setFault(() => false); a.tick(); await flush();
    expect(f.values.has("forkflow.queue.v1.a-1")).toBe(true);
    expect(f.values.get(key)).toBe(JSON.stringify([{ clientRef: "cart-1" }]));
    expect([...f.values.keys()].some(storageKey => storageKey.startsWith("forkflow.queue-result.v1."))).toBe(false);
    expect(acks).toHaveLength(0); expect(a.requests).toHaveLength(1); a.stop();
  });

  it("expires unprotected completion evidence on an idle queue tick", async () => {
    const f = fixture(), a = f.tab("a");
    f.values.set("forkflow.queue-result.v1.orphan.attempt", JSON.stringify({
      version: 1, requestId: "orphan", attemptId: "attempt", userId: "cashier", generation: "g1",
      path: "/api/orders/order-1/items", body: JSON.stringify(items), completedAt: Date.now() - 25 * 60 * 60 * 1000,
      outcome: "success", response: result, printOutcome: "not_requested",
    }));
    a.tick(); await flush();
    expect(f.values.has("forkflow.queue-result.v1.orphan.attempt")).toBe(false);
    expect(a.requests).toHaveLength(0); a.stop();
  });
});
