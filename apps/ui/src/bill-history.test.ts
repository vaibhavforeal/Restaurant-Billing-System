import { describe, expect, it } from "vitest";
import type { Bill } from "@forkflow/domain";
import { BillHistory } from "./bill-history";

const bill = (billNo: number, status: Bill["status"] = "unpaid", suffix = ""): Bill => ({
  id: `b${billNo}${suffix}`, billNo, orderId: `o${billNo}`, createdAt: 0, receipt: {} as Bill["receipt"], status,
  subtotalPaise: 100, discountPaise: 0, discountNote: null, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 100,
  taxes: [], payments: [], refundState: "none", creditNotes: [], refundedQty: {},
});
const rows = (count: number) => Array.from({ length: count }, (_, index) => bill(index + 1));
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const byNumber = (bills: Bill[]) => bills.map(item => item.billNo);

function memoryHistory(source: Bill[], calls: Array<{ status: string; before?: number }> = []) {
  const history = new BillHistory(async (status, before) => {
    calls.push({ status, ...(before === undefined ? {} : { before }) });
    return source.filter(item => status === "all" || item.status === status)
      .filter(item => before === undefined || item.billNo < before)
      .sort((a, b) => b.billNo - a.billNo).slice(0, 100);
  });
  return history;
}

describe("BillHistory", () => {
  it("retains 200 loaded rows after a no-change refresh and caches the next older page", async () => {
    const calls: Array<{ status: string; before?: number }> = [];
    const history = memoryHistory(rows(300), calls);
    await history.refresh();
    await history.loadOlder();
    expect(history.getSnapshot().bills).toHaveLength(200);
    const countBeforeRefresh = calls.length;

    await history.refresh();
    expect(history.getSnapshot().bills).toHaveLength(200);
    expect(history.getSnapshot().bills.at(-1)?.billNo).toBe(101);
    expect(history.getSnapshot().more).toBe(true);
    expect(calls.slice(countBeforeRefresh).map(call => call.before)).toEqual([undefined, 201, 101]);
    const countBeforeLoad = calls.length;
    await history.loadOlder();
    expect(history.getSnapshot().bills).toHaveLength(300);
    expect(calls.slice(countBeforeLoad).map(call => call.before)).toEqual([1]);
  });

  it("includes new head bills while keeping the previous oldest loaded number", async () => {
    const source = rows(300), history = memoryHistory(source);
    await history.refresh(); await history.loadOlder();
    source.push(bill(301), bill(302));
    await history.refresh();
    const visible = history.getSnapshot().bills;
    expect(visible).toHaveLength(202);
    expect(visible[0]?.billNo).toBe(302);
    expect(visible.at(-1)?.billNo).toBe(101);
    expect(history.getSnapshot().more).toBe(true);
  });

  it("reflects settled bills removed from the unpaid filter without losing older unpaid rows", async () => {
    const source = rows(300), history = memoryHistory(source);
    await history.refresh(); await history.loadOlder();
    source.find(item => item.billNo === 250)!.status = "paid";
    await history.refresh();
    const visible = history.getSnapshot().bills;
    expect(visible).toHaveLength(199);
    expect(visible.some(item => item.billNo === 250)).toBe(false);
    expect(visible.at(-1)?.billNo).toBe(101);
  });

  it("continues below a boundary bill removed by filtering and keeps the remaining range", async () => {
    const source = rows(300), history = memoryHistory(source);
    await history.refresh(); await history.loadOlder();
    source.find(item => item.billNo === 101)!.status = "paid";
    await history.refresh();
    expect(history.getSnapshot().bills).toHaveLength(199);
    expect(history.getSnapshot().bills.at(-1)?.billNo).toBe(102);
    expect(history.getSnapshot().more).toBe(true);
  });

  it("detects an exact 100-row ending with a cursor read", async () => {
    const calls: Array<{ status: string; before?: number }> = [];
    const history = memoryHistory(rows(100), calls);
    await history.refresh();
    expect(history.getSnapshot().bills).toHaveLength(100);
    expect(history.getSnapshot().more).toBe(false);
    expect(calls.map(call => call.before)).toEqual([undefined, 1]);
  });

  it("keeps the existing list when a middle refresh page fails", async () => {
    const source = rows(300);
    let failing = false;
    const calls: Array<{ status: string; before?: number }> = [];
    const history = new BillHistory(async (status, before) => {
      calls.push({ status, ...(before === undefined ? {} : { before }) });
      if (failing && before === 101) throw new Error("page two unavailable");
      return source.filter(item => status === "all" || item.status === status).filter(item => before === undefined || item.billNo < before)
        .sort((a, b) => b.billNo - a.billNo).slice(0, 100);
    });
    await history.refresh(); await history.loadOlder();
    const previous = history.getSnapshot().bills;
    failing = true;
    await history.refresh();
    expect(history.getSnapshot().bills).toEqual(previous);
    expect(history.getSnapshot().error).toBe("page two unavailable");
    expect(history.getSnapshot().busy).toBe(false);
  });

  it("invalidates a prior filter request and loads only the new status", async () => {
    let release!: (page: Bill[]) => void;
    const history = new BillHistory((status) => status === "unpaid"
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve([bill(8, "paid")]));
    const old = history.refresh();
    await tick();
    history.setStatus("paid");
    await history.refresh();
    release([bill(9, "unpaid")]); await old;
    expect(history.getSnapshot().status).toBe("paid");
    expect(byNumber(history.getSnapshot().bills)).toEqual([8]);
  });

  it("coalesces refreshes arriving during Load older into one sequential follow-up", async () => {
    const source = rows(300);
    let active = 0, maxActive = 0, delayed = false, release!: (page: Bill[]) => void;
    const history = new BillHistory(async (_status, before) => {
      active++; maxActive = Math.max(maxActive, active);
      try {
        if (before === 1 && !delayed) {
          delayed = true;
          return await new Promise<Bill[]>(resolve => { release = resolve; });
        }
        return source.filter(item => before === undefined || item.billNo < before).sort((a, b) => b.billNo - a.billNo).slice(0, 100);
      } finally { active--; }
    });
    await history.refresh(); await history.loadOlder();
    const loading = history.loadOlder();
    await tick();
    const refreshA = history.refresh(), refreshB = history.refresh();
    expect(active).toBe(1);
    release([]); await loading; await Promise.all([refreshA, refreshB]); await tick();
    expect(maxActive).toBe(1);
    expect(history.getSnapshot().bills).toHaveLength(300);
  });

  it("publishes an empty first page and clears the more flag", async () => {
    const history = memoryHistory([]);
    await history.refresh();
    expect(history.getSnapshot()).toMatchObject({ bills: [], more: false, error: "", busy: false });
  });

  it("publishes refreshed pages atomically and deduplicates overlapping rows", async () => {
    const source = rows(250);
    let overlap = false;
    const history = new BillHistory(async (_status, before) => {
      const page = source.filter(item => before === undefined || item.billNo < before).sort((a, b) => b.billNo - a.billNo).slice(0, 100);
      return overlap && before !== undefined ? [bill(before), ...page] : page;
    });
    await history.refresh(); await history.loadOlder();
    const previous = history.getSnapshot().bills;
    const published: Bill[][] = [];
    history.subscribe(snapshot => { published.push(snapshot.bills); });
    overlap = true; source.push(bill(251));
    await history.refresh();
    expect(published).toHaveLength(2);
    expect(published[0]).toBe(previous);
    expect(published[1]).toHaveLength(201);
    expect(new Set(published[1]!.map(item => item.id)).size).toBe(201);
    expect(published[1]!.at(-1)?.billNo).toBe(51);
  });

  it("preserves the boundary and visible rows when an older-page read fails, then retries", async () => {
    const source = rows(250);
    let fail = true;
    const history = new BillHistory(async (_status, before) => {
      if (before === 51 && fail) throw new Error("Older page unavailable");
      return source.filter(item => before === undefined || item.billNo < before).sort((a, b) => b.billNo - a.billNo).slice(0, 100);
    });
    await history.refresh();
    const previous = history.getSnapshot().bills;
    await history.loadOlder();
    expect(history.getSnapshot()).toMatchObject({ bills: previous, error: "Older page unavailable", more: true, busy: false });
    fail = false; await history.loadOlder();
    expect(history.getSnapshot().bills).toHaveLength(200);
    expect(history.getSnapshot().bills.at(-1)?.billNo).toBe(51);
    expect(history.getSnapshot().error).toBe("");
  });

  it("keeps a deleted boundary as the refresh limit and handles exact 200-row exhaustion", async () => {
    const source = rows(200), history = memoryHistory(source);
    await history.refresh(); await history.loadOlder();
    source.splice(0, 1);
    await history.refresh();
    expect(history.getSnapshot().bills).toHaveLength(199);
    expect(history.getSnapshot().bills.at(-1)?.billNo).toBe(2);
    expect(history.getSnapshot().more).toBe(false);
  });

  it("ignores responses and queued work after disposal", async () => {
    let release!: (page: Bill[]) => void;
    const history = new BillHistory(() => new Promise(resolve => { release = resolve; }));
    const pending = history.refresh(); const queued = history.loadOlder();
    const previous = history.getSnapshot();
    history.dispose(); release([bill(1)]);
    await pending; await queued;
    expect(history.getSnapshot()).toBe(previous);
  });

  it("invalidates Load older queued behind a refresh when the filter changes", async () => {
    let release!: (page: Bill[]) => void;
    const history = new BillHistory((status, before) => status === "unpaid"
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve(rows(150)
        .map(item => ({ ...item, status: "paid" as const })).filter(item => before === undefined || item.billNo < before)
        .sort((a, b) => b.billNo - a.billNo).slice(0, 100)));
    const refreshing = history.refresh();
    const queued = history.loadOlder();
    history.setStatus("paid");
    await history.refresh();
    release([bill(999)]);
    await refreshing; await queued;
    expect(history.getSnapshot().bills).toHaveLength(100);
    expect(history.getSnapshot().bills.every(item => item.status === "paid")).toBe(true);
  });
});
