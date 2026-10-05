import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestRequest } from "@forkflow/domain";
import { QrArrivalTracker, startQrMonitor } from "./qr-notifications";

const request = (id: string, expiresAt = Date.now() + 60_000) => ({ id, expiresAt }) as GuestRequest;
afterEach(() => vi.useRealTimers());

describe("QR arrivals", () => {
  it("shows existing pending requests silently and notifies only once for new IDs", () => {
    const tracker = new QrArrivalTracker();
    const old = request("old"), next = request("new");
    expect(tracker.update([old])).toEqual([]);
    expect(tracker.update([next, old])).toEqual([next]);
    expect(tracker.update([old, next])).toEqual([]);
    tracker.update([]);
    expect(tracker.update([next])).toEqual([]);
  });
  it("handles batches and never alerts on already expired requests", () => {
    const tracker = new QrArrivalTracker();
    tracker.update([]);
    const a = request("a"), b = request("b");
    expect(tracker.update([a, b, request("expired", Date.now() - 1)])).toEqual([a, b]);
  });
});

describe("QR monitoring", () => {
  it("refetches when a live event arrives during an in-flight read", async () => {
    vi.useFakeTimers();
    let refresh = () => {};
    let resolve!: (requests: GuestRequest[]) => void;
    const next = request("new");
    const read = vi.fn().mockImplementationOnce(() => new Promise<GuestRequest[]>((done) => { resolve = done; })).mockResolvedValue([next]);
    const onSnapshot = vi.fn();
    const stop = startQrMonitor({ read, onSnapshot, onError: vi.fn(), subscribe: (fn) => { refresh = fn; return () => {}; } });
    refresh(); refresh();
    expect(read).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenLastCalledWith([next], [next]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onSnapshot).toHaveBeenLastCalledWith([next], []);
    stop();
  });
  it("recovers from a failed poll without forgetting previously seen requests", async () => {
    vi.useFakeTimers();
    const old = request("old"), next = request("new");
    const onSnapshot = vi.fn(), onError = vi.fn();
    const read = vi.fn().mockResolvedValueOnce([old]).mockRejectedValueOnce(new Error("offline")).mockResolvedValue([next, old]);
    const stop = startQrMonitor({ read, onSnapshot, onError, subscribe: () => () => {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenLastCalledWith([next, old], [next]);
    stop();
  });
  it("aborts on logout/unmount and ignores late results", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    let resolve!: (requests: GuestRequest[]) => void;
    const unsubscribe = vi.fn(), onSnapshot = vi.fn();
    const read = vi.fn((value: AbortSignal) => { signal = value; return new Promise<GuestRequest[]>((done) => { resolve = done; }); });
    const stop = startQrMonitor({ read, onSnapshot, onError: vi.fn(), subscribe: () => unsubscribe });
    stop();
    resolve([request("late")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });
});
