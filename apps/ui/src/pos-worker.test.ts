import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { posWorker } from "../pos-pwa-plugin";

function worker() {
  const handlers = new Map<string, (event: any) => void>(), stores = new Map<string, Map<string, Response>>();
  let online = true, skipped = false;
  const cache = (name: string) => { if (!stores.has(name)) stores.set(name, new Map()); const entries = stores.get(name)!; return { put: async (key: string, value: Response) => { entries.set(key, value.clone()); }, match: async (key: string) => entries.get(key)?.clone() }; };
  runInNewContext(posWorker("test", ["/assets/app.js", "/assets/app.css"]), {
    self: { location: { origin: "https://outlet.test" }, addEventListener: (name: string, handler: any) => handlers.set(name, handler), clients: { claim: async () => undefined }, skipWaiting: () => { skipped = true; } },
    caches: { open: async (name: string) => cache(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
    Request: class extends Request { constructor(url: string, init: RequestInit) { super(new URL(url, "https://outlet.test"), init); } },
    fetch: async () => { if (!online) throw new Error("offline"); return new Response("release-one"); }, URL, Response, AbortSignal,
  });
  return {
    stores, cache, offline: () => { online = false; }, skipped: () => skipped,
    lifecycle: (name: string) => { let promise: Promise<void> | undefined; handlers.get(name)!({ waitUntil: (value: Promise<void>) => { promise = value; } }); return promise; },
    request: (path: string, method = "GET", mode = "cors") => { let response: Promise<Response> | undefined; handlers.get("fetch")!({ request: { url: new URL(path, "https://outlet.test").href, method, mode }, respondWith: (value: Promise<Response>) => { response = value; } }); return response; },
  };
}
describe("cashier shell resilience", () => {
  it("opens its matching shell and static build assets offline without forcing active sessions to update", async () => {
    const w = worker(); await w.lifecycle("install"); w.offline();
    expect(await (await w.request("/", "GET", "navigate"))!.text()).toBe("release-one");
    expect(await (await w.request("/assets/app.js"))!.text()).toBe("release-one");
    expect(w.skipped()).toBe(false);
  });
  it("never intercepts API, cloud, writes, guest or other staff navigation", () => {
    const w = worker();
    for (const [path, method, mode] of [["/api/orders", "GET", "cors"], ["/v1/outlets", "GET", "cors"], ["/api/orders/send", "POST", "cors"], ["/", "POST", "navigate"], ["/captain/", "GET", "navigate"], ["/kitchen/", "GET", "navigate"], ["/menu", "GET", "navigate"], ["https://other.test/assets/app.js", "GET", "cors"]]) expect(w.request(path!, method, mode)).toBeUndefined();
  });
  it("cleans only old cashier caches and preserves Captain and Kitchen installs", async () => {
    const w = worker(); w.cache("forkflow-pos-old"); w.cache("forkflow-captain-one"); w.cache("forkflow-kitchen-one");
    await w.lifecycle("install"); await w.lifecycle("activate");
    expect([...w.stores.keys()].sort()).toEqual(["forkflow-captain-one", "forkflow-kitchen-one", "forkflow-pos-test"]);
  });
});
