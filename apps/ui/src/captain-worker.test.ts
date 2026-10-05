import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { captainWorker } from "../captain-worker";

function worker(entry: "captain" | "kitchen" = "captain") {
  const handlers = new Map<string, (event: any) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const cache = (name: string) => {
    let entries = stores.get(name); if (!entries) { entries = new Map(); stores.set(name, entries); }
    return { match: async (url: string) => entries.get(url)?.clone(), put: async (url: string, value: Response) => { entries.set(url, value.clone()); } };
  };
  const fetch = vi.fn(async () => new Response("shell-v1"));
  const claim = vi.fn(), skipWaiting = vi.fn();
  runInNewContext(captainWorker("test", ["/assets/app-v1.js", "/assets/app-v1.css"], entry), {
    self: { location: { origin: "https://pos.test" }, addEventListener: (name: string, fn: any) => handlers.set(name, fn), clients: { claim }, skipWaiting },
    caches: { open: async (name: string) => cache(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
    Request: class extends Request { constructor(url: string, init: RequestInit) { super(new URL(url, "https://pos.test"), init); } },
    Response, URL, AbortSignal, fetch,
  });
  const lifecycle = (name: string) => { let promise: Promise<void> | undefined; handlers.get(name)!({ waitUntil: (value: Promise<void>) => { promise = value; } }); return promise; };
  const request = (url: string, method = "GET", mode = "cors") => {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: { url: new URL(url, "https://pos.test").href, method, mode }, respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  };
  return { fetch, stores, cache, lifecycle, request, claim, skipWaiting };
}
describe("Captain service worker boundaries", () => {
  it("isolates Kitchen caches and never caches tickets or Captain navigation", async () => {
    const w = worker("kitchen"); w.cache("forkflow-captain-existing"); w.cache("forkflow-kitchen-old");
    await w.lifecycle("install"); await w.lifecycle("activate");
    expect([...w.stores.keys()].sort()).toEqual(["forkflow-captain-existing", "forkflow-kitchen-test"]);
    expect(w.request("/api/kots")).toBeUndefined();
    expect(w.request("/api/kots/one/accept", "POST")).toBeUndefined();
    expect(w.request("/captain/", "GET", "navigate")).toBeUndefined();
    w.fetch.mockRejectedValue(new TypeError("offline"));
    expect(await (await w.request("/kitchen/", "GET", "navigate"))!.text()).toBe("shell-v1");
  });
  it("caches only the shell and declared build assets, never forcing a live order update", async () => {
    const w = worker(); await w.lifecycle("install");
    expect([...w.stores.get("forkflow-captain-test")!.keys()].sort()).toEqual(["/assets/app-v1.css", "/assets/app-v1.js", "/captain/"]);
    expect(w.skipWaiting).not.toHaveBeenCalled();
  });
  it("does not intercept API reads, writes, guest navigation or external resources", () => {
    const w = worker();
    for (const [url, method, mode] of [["/api/orders", "GET", "cors"], ["/api/orders/1/send", "POST", "cors"], ["/api/products/photo", "GET", "cors"], ["/menu", "GET", "navigate"], ["/", "GET", "navigate"], ["https://elsewhere.test/assets/app-v1.js", "GET", "cors"]]) {
      expect(w.request(url!, method, mode)).toBeUndefined();
    }
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it("opens the matching cached shell and assets offline", async () => {
    const w = worker(); await w.lifecycle("install"); w.fetch.mockRejectedValue(new TypeError("offline"));
    expect(await (await w.request("/captain/", "GET", "navigate"))!.text()).toBe("shell-v1");
    expect(await (await w.request("/assets/app-v1.js"))!.text()).toBe("shell-v1");
  });
  it("keeps navigation on the installed release while an update is waiting", async () => {
    const w = worker(); await w.lifecycle("install"); w.fetch.mockResolvedValue(new Response("shell-v2"));
    w.fetch.mockClear();
    expect(await (await w.request("/captain/", "GET", "navigate"))!.text()).toBe("shell-v1");
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await (await w.cache("forkflow-captain-test").match("/captain/"))!.text()).toBe("shell-v1");
  });
  it("removes only old Captain caches when activation is safe", async () => {
    const w = worker(); w.cache("forkflow-captain-old"); w.cache("other-app"); await w.lifecycle("install"); await w.lifecycle("activate");
    expect([...w.stores.keys()].sort()).toEqual(["forkflow-captain-test", "other-app"]); expect(w.claim).toHaveBeenCalledOnce();
  });
  it("rejects an incomplete download instead of activating a broken offline shell", async () => {
    const w = worker(); w.fetch.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(w.lifecycle("install")).rejects.toThrow("Captain shell download failed");
  });
});
