import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<() => unknown> = [];
  let cursor = 0;
  return {
    state, refs, effects,
    apiFetch: vi.fn(), connectWs: vi.fn(() => () => {}),
    reset: () => { state.length = 0; refs.length = 0; effects.length = 0; cursor = 0; },
    beginRender: () => { cursor = 0; effects.length = 0; },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [state[index], (value: unknown) => { state[index] = typeof value === "function" ? (value as (current: unknown) => unknown)(state[index]) : value; }];
    },
    useRef: (value: unknown) => {
      const index = cursor++;
      if (!(index in refs)) refs[index] = { current: value };
      return refs[index];
    },
    useCallback: (callback: unknown) => { cursor++; return callback; },
    useEffect: (callback: () => unknown) => { effects.push(callback); },
  };
});

vi.mock("react", () => ({ useState: harness.useState, useRef: harness.useRef, useCallback: harness.useCallback, useEffect: harness.useEffect }));
vi.mock("./api", () => ({ apiFetch: harness.apiFetch, session: { clear: vi.fn() } }));
vi.mock("./ws", () => ({ connectWs: harness.connectWs }));

import type { AnalyticsHour, OrderAnalyticsReport, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import { useDashboard } from "./useDashboard";
import { channelCards, slotBars } from "./dashboard-data";

const hours = (paise: number): AnalyticsHour[] => Array.from({ length: 24 }, (_, hour) => ({ hour, orderCount: hour === 20 && paise ? 1 : 0, totalPaise: hour === 20 ? paise : 0 }));
const comparison = (zomatoPaise = 0, zomatoCount = zomatoPaise ? 1 : 0): OrderTypeAnalytics[] => [
  { type: "dine_in", orderCount: 0, qty: 0, totalPaise: 0 },
  { type: "parcel", orderCount: 0, qty: 0, totalPaise: 0 },
  ...(zomatoCount || zomatoPaise ? [{ type: "zomato" as const, orderCount: zomatoCount, qty: zomatoCount, totalPaise: zomatoPaise }] : []),
];
const report = (hourlyPaise = 0, comparisonPaise = hourlyPaise, zomatoCount = comparisonPaise ? 1 : 0): OrderAnalyticsReport => ({
  from: "2026-10-10", to: "2026-10-10", today: "2026-10-11", timezone: "Asia/Kolkata", generatedAt: 0, orderType: "all",
  totals: { orderCount: 0, qty: 0, totalPaise: 0 }, comparison: comparison(comparisonPaise, zomatoCount), hourly: hours(hourlyPaise), daily: [], items: [], categories: [],
});

function responseFor(path: string, zomatoPaise = 20_000, zomatoCount = zomatoPaise ? 1 : 0) {
  if (path.includes("type=zomato")) return { report: report(zomatoPaise, zomatoPaise, zomatoCount) };
  if (path.includes("type=dine_in")) return { report: report(0, zomatoPaise, zomatoCount) };
  if (path.includes("type=parcel")) return { report: report(0, zomatoPaise, zomatoCount) };
  if (path.startsWith("/api/reports/day-end")) return { report: { sales: { billCount: 0 }, cancellations: { orderCount: 0 } } };
  if (path.startsWith("/api/reports/sales")) return { report: {} };
  return { orders: [] };
}

function render(date = "2026-10-10") {
  harness.beginRender();
  const value = useDashboard(date);
  return { ...value, effects: [...harness.effects] };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function load(date = "2026-10-10") {
  const view = render(date);
  const cleanup = view.effects[0]!() as () => void;
  await tick();
  return { view: render(date), cleanup };
}

describe("useDashboard historical Zomato analytics", () => {
  beforeEach(() => {
    harness.reset(); harness.apiFetch.mockReset();
    harness.apiFetch.mockImplementation(async (path: string) => responseFor(path));
  });

  it("loads a recorded Zomato sale while the live integration is disabled", async () => {
    const { view } = await load("2026-10-10");
    const requested = harness.apiFetch.mock.calls.map(([path]) => String(path));
    expect(channelCards(view.analytics!.dineIn.comparison, false)).toMatchObject({ total: { amountPaise: 20_000 }, zomato: { amountPaise: 20_000 } });
    expect(slotBars(view.analytics!.dineIn.hourly, view.analytics!.takeaway.hourly, view.analytics!.zomato).reduce((sum, bar) => sum + bar.totalPaise, 0)).toBe(20_000);
    expect(requested.some(path => path.includes("from=2026-10-10") && path.includes("type=zomato"))).toBe(true);
    expect(view.analytics?.zomato?.hourly.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(20_000);
    expect(view.error).toBe("");
  });

  it("keeps empty history empty and requests the same report independent of live controls", async () => {
    harness.apiFetch.mockImplementation(async (path: string) => responseFor(path, 0));
    const disabled = await load("2026-10-10");
    expect(disabled.view.analytics?.zomato?.hourly.every(row => row.totalPaise === 0)).toBe(true);
    expect(harness.apiFetch.mock.calls.some(([path]) => String(path).includes("type=zomato"))).toBe(true);
    disabled.cleanup();
    harness.reset(); harness.apiFetch.mockImplementation(async (path: string) => responseFor(path, 0));
    const enabled = await load("2026-10-10");
    expect(harness.apiFetch.mock.calls.some(([path]) => String(path).includes("type=zomato"))).toBe(true);
    expect(channelCards(enabled.view.analytics!.dineIn.comparison, true).zomato).toEqual({ amountPaise: 0, orderCount: 0 });
    enabled.cleanup();
  });

  it("retains zero-net recorded activity in the Zomato card", async () => {
    harness.apiFetch.mockImplementation(async (path: string) => path.includes("type=zomato") ? { report: report(0, 0, 1) } : responseFor(path, 0, 1));
    const { view, cleanup } = await load("2026-10-10");
    expect(channelCards(view.analytics!.dineIn.comparison, false).zomato).toEqual({ amountPaise: 0, orderCount: 1 });
    cleanup();
  });

  it("shows an incomplete-data error for failed Zomato history and succeeds on retry", async () => {
    let fail = true;
    harness.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("type=zomato") && fail) throw new Error("Historical analytics unavailable");
      return responseFor(path);
    });
    let first = render(); const cleanupFirst = first.effects[0]!() as () => void;
    await tick(); first = render();
    expect(first.error).toBe("Historical analytics unavailable");
    expect(first.analytics?.zomato).toBeNull();
    fail = false;
    first.refresh();
    let retry = render(); const cleanupRetry = retry.effects[0]!() as () => void;
    await tick(); retry = render();
    expect(retry.error).toBe("");
    expect(retry.analytics?.zomato?.hourly.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(20_000);
    cleanupFirst(); cleanupRetry();
  });

  it("changes the requested history with the selected date and ignores the late prior date", async () => {
    let finishOld!: (value: { report: OrderAnalyticsReport }) => void;
    harness.apiFetch.mockImplementation((path: string) => path.includes("type=zomato") && path.includes("2026-10-10")
      ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(responseFor(path, 5_000)));
    let old = render("2026-10-10"); const stopOld = old.effects[0]!() as () => void;
    stopOld();
    let current = render("2026-10-11"); const stopCurrent = current.effects[0]!() as () => void;
    await tick(); current = render("2026-10-11");
    expect(current.analytics?.zomato?.hourly.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(5_000);
    finishOld({ report: report(99_000) }); await tick();
    expect(render("2026-10-11").analytics?.zomato?.hourly.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(5_000);
    expect(harness.apiFetch.mock.calls.some(([path]) => String(path).includes("from=2026-10-11") && String(path).includes("type=zomato"))).toBe(true);
    stopOld(); stopCurrent();
  });

  it("retains same-date historical figures on a partial failure without reusing them for another day", async () => {
    const initial = await load();
    const prior = initial.view.analytics?.zomato;
    const priorTime = initial.view.updatedAt;
    harness.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("type=zomato")) throw new Error("Historical request failed");
      return responseFor(path, 0);
    });
    initial.cleanup();
    const retry = await load();
    expect(retry.view.analytics?.zomato).toBe(prior);
    expect(retry.view.updatedAt).toBe(priorTime);
    expect(retry.view.error).toBe("Historical request failed");
    retry.cleanup();
    const nextDay = await load("2026-10-11");
    expect(nextDay.view.analytics?.zomato).toBeNull();
    expect(nextDay.view.updatedAt).toBeNull();
    expect(nextDay.view.error).toBe("Historical request failed");
    nextDay.cleanup();
  });
});
