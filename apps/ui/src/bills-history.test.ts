import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const states: unknown[] = [], refs: Array<{ current: unknown }> = [], effects: Array<() => unknown> = [];
  let cursor = 0;
  const apiFetch = vi.fn();
  return {
    states, refs, effects, handler: undefined as undefined | { onEvent: (event: string) => void }, apiFetch,
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? (value as (current: unknown) => unknown)(states[index]) : value; }];
    },
    useEffect: (callback: () => unknown) => { effects.push(callback); },
    useRef: (value: unknown) => {
      const index = cursor++;
      if (!(index in refs)) refs[index] = { current: value };
      return refs[index];
    },
    beginRender: () => { cursor = 0; effects.length = 0; },
    reset: () => { states.length = 0; refs.length = 0; effects.length = 0; cursor = 0; harness.handler = undefined; apiFetch.mockReset(); },
  };
});

vi.mock("react", () => ({ useState: harness.useState, useEffect: harness.useEffect, useRef: harness.useRef }));
vi.mock("./api", () => ({ apiFetch: harness.apiFetch, session: { clear: vi.fn() } }));
vi.mock("./money", () => ({ paiseToRupees: (value: number) => String(value) }));
vi.mock("./credit-note-form", () => ({ billStatusLabel: () => "" }));
vi.mock("./zomato-desk", () => ({ billContextLabel: () => "" }));
vi.mock("./PosControls", () => ({ TableScroller: "div" }));

import type { Bill } from "@forkflow/domain";

const makeBill = (number: number): Bill => ({
  id: `b${number}`, billNo: number, orderId: `o${number}`, createdAt: 0, receipt: { orderType: "parcel", items: [] } as unknown as Bill["receipt"],
  status: "unpaid", subtotalPaise: 100, discountPaise: 0, discountNote: null, cgstPaise: 0, sgstPaise: 0,
  roundingPaise: 0, totalPaise: 100, taxes: [], payments: [], refundState: "none", creditNotes: [], refundedQty: {},
});
const newest = Array.from({ length: 100 }, (_, index) => makeBill(200 - index));
const older = Array.from({ length: 100 }, (_, index) => makeBill(100 - index));
const tree = (value: unknown): any => value;
function findLoadOlder(value: any): any {
  if (!value || typeof value !== "object") return null;
  if (value.type === "button" && value.props.children === "Load older bills") return value;
  const children = value.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findLoadOlder(child);
    if (found) return found;
  }
  return null;
}
function render(Bills: (props: { onOpenOrder: (id: string) => void }) => unknown) { harness.beginRender(); return tree(Bills({ onOpenOrder: () => {} })); }
function billNumbers(value: any): number[] {
  if (!value || typeof value !== "object") return [];
  if (value.type === "button" && Array.isArray(value.props.children) && value.props.children[0] === "Open bill #") return [value.props.children[1]];
  const children = value.props?.children;
  return (Array.isArray(children) ? children : [children]).flatMap(child => Array.isArray(child) ? child.flatMap(billNumbers) : billNumbers(child));
}
function findElement(value: any, type: string): any {
  if (!value || typeof value !== "object") return null;
  if (value.type === type) return value;
  const children = value.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("Bills history screen wiring", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(() => {
    harness.reset();
    harness.apiFetch.mockImplementation(async (path: string) => {
      const before = new URL(path, "http://fixture").searchParams.get("before");
      return { bills: [...newest, ...older].filter(bill => before === null || bill.billNo < Number(before)).slice(0, 100) };
    });
  });

  it("retains all loaded rows through the oldest bill after an unrelated live update", async () => {
    vi.resetModules();
    vi.doMock("./ws", () => ({ connectWs: (hooks: { onEvent: (event: string) => void }) => { harness.handler = hooks; return () => {}; } }));
    const { Bills } = await import("./screens/Bills");
    render(Bills);
    harness.effects[0]!();
    await tick();
    expect(billNumbers(render(Bills))).toHaveLength(100);

    await findLoadOlder(render(Bills)).props.onClick();
    await tick();
    expect(billNumbers(render(Bills))).toHaveLength(200);
    harness.handler!.onEvent("order.updated");
    await new Promise(resolve => setTimeout(resolve, 280));

    expect(billNumbers(render(Bills))).toHaveLength(200);
    expect(billNumbers(render(Bills)).at(-1)).toBe(1);
  });

  it("times out a stalled older-page read after 15 seconds, retains rows, and allows retry", async () => {
    vi.useFakeTimers();
    // Native AbortSignal.timeout uses an internal timer; route it through the controlled clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Bill request timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    let stall = true;
    const regularFetch = harness.apiFetch.getMockImplementation()!;
    harness.apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (!path.endsWith("before=1") || !stall) return regularFetch(path, init);
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const { Bills } = await import("./screens/Bills");
    render(Bills);
    const cleanup = harness.effects[0]!() as () => void;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(billNumbers(render(Bills))).toHaveLength(100);
      findLoadOlder(render(Bills)).props.onClick();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(findElement(render(Bills), "select").props.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const timedOut = render(Bills);
      expect(findElement(timedOut, "select").props.disabled).toBe(false);
      expect(findElement(timedOut, "p").props.children).toBe("Bill request timed out");
      expect(billNumbers(timedOut)).toHaveLength(100);
      expect(findLoadOlder(timedOut).props.disabled).toBe(false);
      stall = false;
      findLoadOlder(timedOut).props.onClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(billNumbers(render(Bills))).toHaveLength(200);
      expect(findElement(render(Bills), "p").props.children).toBe("");
    } finally { cleanup(); }
  });

  it("still aborts a pending page immediately when the history filter changes", async () => {
    let pendingSignal: AbortSignal | null | undefined;
    harness.apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes("status=paid")) return Promise.resolve({ bills: [makeBill(9)] });
      pendingSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        pendingSignal?.addEventListener("abort", () => reject(pendingSignal?.reason), { once: true });
      });
    });
    const { Bills } = await import("./screens/Bills");
    render(Bills);
    const cleanup = harness.effects[0]!() as () => void;
    try {
      findElement(render(Bills), "select").props.onChange({ target: { value: "paid" } });
      expect(pendingSignal?.aborted).toBe(true);
      await tick();
      expect(billNumbers(render(Bills))).toEqual([9]);
      expect(findElement(render(Bills), "select").props.disabled).toBe(false);
      expect(findElement(render(Bills), "p").props.children).toBe("");
    } finally { cleanup(); }
  });
});
