import { describe, expect, it, vi } from "vitest";
import { overLimit } from "./limits.js";

const request = new Request("https://licensing.example/v1/enroll", { headers: { "cf-connecting-ip": "203.0.113.9" } });

describe("overLimit", () => {
  it("counts each surface separately by address, and says when a caller is over", async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.length < 2 }; } };
    expect(await overLimit(limiter, request, "portal")).toBe(false);
    expect(await overLimit(limiter, request, "")).toBe(true);
    expect(keys).toEqual(["portal:203.0.113.9", "203.0.113.9"]);
  });

  it("fails open when the limiter is down, or closed for surfaces that hand out access", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = { limit: async () => { throw new TypeError("binding missing"); } };
    expect(await overLimit(down, request, "support")).toBe(false);
    expect(await overLimit(down, request, "connector", true)).toBe(true);
    expect(console.error).toHaveBeenCalledWith("licensing-worker: rate limiter unavailable:", "TypeError");
  });
});
