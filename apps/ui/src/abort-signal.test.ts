import { afterEach, describe, expect, it, vi } from "vitest";
import { anySignal, timeoutSignal, withTimeout } from "./abort-signal";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });


describe("abort signal helpers without AbortSignal.any / timeout", () => {
  it("aborts the combined signal when any source aborts", () => {
    const a = new AbortController(), b = new AbortController();
    const saved = { any: AbortSignal.any, timeout: AbortSignal.timeout };
    (AbortSignal as unknown as Record<string, unknown>).any = undefined;
    try {
      const combined = anySignal([a.signal, b.signal]);
      expect(combined.aborted).toBe(false);
      b.abort(new Error("stop"));
      expect(combined.aborted).toBe(true);
      expect((combined.reason as Error).message).toBe("stop");
      expect(anySignal([a.signal, b.signal]).aborted).toBe(true);
    } finally { Object.assign(AbortSignal, saved); }
  });

  it("times out after the delay", () => {
    vi.useFakeTimers();
    const saved = AbortSignal.timeout;
    (AbortSignal as unknown as Record<string, unknown>).timeout = undefined;
    try {
      const signal = timeoutSignal(1000);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(signal.aborted).toBe(true);
    } finally { AbortSignal.timeout = saved; }
  });

  it("combines a caller signal with a timeout using native support too", () => {
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 60_000);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
