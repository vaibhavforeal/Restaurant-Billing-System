import { describe, expect, it } from "vitest";
import { CloudApi, CloudError, freshness, parseRupees, money } from "./api";

describe("owner portal trust boundaries", () => {
  it("invokes browser fetch without an invalid class receiver", async () => {
    const transport = async function(this: unknown) { if (this !== undefined) throw new TypeError("Illegal invocation"); return Response.json({ ok: true }); };
    const api = new CloudApi(transport);
    await expect(api.request("/auth/me")).resolves.toEqual({ ok: true });
  });
  it("keeps credentials in cookies and sends the current CSRF token on mutations", async () => {
    const requests: RequestInit[] = [];
    const api = new CloudApi(async (_url, init) => { requests.push(init!); return Response.json({ csrfToken: "csrf-1", user: { id: "owner" } }); });
    await api.request("/auth/me");
    await api.request("/outlets", { method: "POST", body: JSON.stringify({ name: "Main" }) });
    expect(requests[0]?.credentials).toBe("include");
    expect(new Headers(requests[1]?.headers).get("x-csrf-token")).toBe("csrf-1");
    expect(requests[1]?.cache).toBe("no-store");
    expect(new Headers(requests[1]?.headers).has("authorization")).toBe(false);
  });
  it("surfaces server errors and clears CSRF on expired sessions", async () => {
    let count = 0;
    const api = new CloudApi(async () => ++count === 1 ? Response.json({ csrfToken: "old" }) : Response.json({ error: "Session expired" }, { status: 401 }));
    await api.request("/auth/me");
    await expect(api.request("/outlets")).rejects.toMatchObject({ status: 401, message: "Session expired" });
    expect(api.csrfToken).toBe(null);
  });
  it("does not turn service outages into empty successful data", async () => {
    const api = new CloudApi(async () => new Response("gateway down", { status: 503 }));
    await expect(api.request("/outlets")).rejects.toBeInstanceOf(CloudError);
  });
  it("distinguishes never uploaded, recent and stale outlet snapshots", () => {
    expect(freshness(null, 1_000_000).state).toBe("unknown");
    expect(freshness(999_000, 1_000_000).state).toBe("recent");
    expect(freshness(100_000, 1_000_000).state).toBe("stale");
  });
  it("converts entered rupees without floating point rounding or invalid money", () => {
    expect(parseRupees("199.99")).toBe(19999);
    expect(parseRupees("0.10")).toBe(10);
    for (const value of ["-1", "1.001", "", "abc", "1e3"]) expect(() => parseRupees(value)).toThrow();
    expect(money("12345678901234567890")).toBe("₹123,456,789,012,345,678.90");
    expect(money("151.5")).toBe("₹1.52");
    expect(money("-151.5")).toBe("−₹1.52");
  });
});
