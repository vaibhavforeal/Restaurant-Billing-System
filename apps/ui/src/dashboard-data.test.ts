import { describe, expect, it } from "vitest";
import type { AnalyticsHour, OrderAnalyticsReport, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import type { Order } from "./types";
import { SLOTS, ageLabel, aggregatorAlerts, channelCards, orderStats, slotBars, slotIndex } from "./dashboard-data";

const hours = (fill: (hour: number) => number): AnalyticsHour[] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, orderCount: fill(hour) > 0 ? 1 : 0, totalPaise: fill(hour) }));

describe("dashboard slots", () => {
  it("labels six four-hour slots", () => {
    expect(SLOTS.map(slot => slot.label)).toEqual([
      "01:00am - 05:00am", "05:00am - 09:00am", "09:00am - 01:00pm",
      "01:00pm - 05:00pm", "05:00pm - 09:00pm", "09:00pm - 01:00am",
    ]);
  });

  it("maps the 00:00-00:59 hour to the last slot", () => {
    expect(slotIndex(0)).toBe(5);
    expect(slotIndex(1)).toBe(0);
    expect(slotIndex(4)).toBe(0);
    expect(slotIndex(5)).toBe(1);
    expect(slotIndex(12)).toBe(2);
    expect(slotIndex(21)).toBe(5);
    expect(slotIndex(23)).toBe(5);
  });

  it("sums each channel into six bars, with midnight and 21-23 in the last bar", () => {
    const bars = slotBars(hours(hour => (hour === 0 || hour >= 21 ? 100 : hour === 2 ? 50 : 0)), hours(hour => (hour === 0 ? 7 : hour === 13 ? 30 : 0)));
    expect(bars).toHaveLength(6);
    expect(bars[0]).toMatchObject({ label: "01:00am - 05:00am", dineInPaise: 50, takeawayPaise: 0, totalPaise: 50 });
    expect(bars[3]).toMatchObject({ dineInPaise: 0, takeawayPaise: 30, totalPaise: 30 });
    expect(bars[5]).toMatchObject({ label: "09:00pm - 01:00am", dineInPaise: 400, takeawayPaise: 7, totalPaise: 407 });
  });

  it("adds a third Zomato series and keeps the total across all three", () => {
    const bars = slotBars(hours(hour => (hour === 13 ? 100 : 0)), hours(hour => (hour === 13 ? 30 : 0)), { hourly: hours(hour => (hour === 13 ? 20 : hour === 0 ? 5 : 0)) } as OrderAnalyticsReport);
    expect(bars[3]).toMatchObject({ dineInPaise: 100, takeawayPaise: 30, zomatoPaise: 20, totalPaise: 150 });
    expect(bars[5]).toMatchObject({ dineInPaise: 0, takeawayPaise: 0, zomatoPaise: 5, totalPaise: 5 });
  });

  it("leaves zomatoPaise at zero when the Zomato report is omitted or null", () => {
    for (const bars of [slotBars(hours(() => 1), hours(() => 1)), slotBars(hours(() => 1), hours(() => 1), null)]) {
      for (const bar of bars) expect(bar.zomatoPaise).toBe(0);
    }
  });

  it("returns six zero bars for empty input", () => {
    for (const bars of [slotBars(hours(() => 0), hours(() => 0)), slotBars([], [])]) {
      expect(bars).toHaveLength(6);
      for (const bar of bars) expect([bar.dineInPaise, bar.takeawayPaise, bar.totalPaise]).toEqual([0, 0, 0]);
    }
  });
});

describe("channelCards", () => {
  it("totals both order types", () => {
    const comparison: OrderTypeAnalytics[] = [
      { type: "parcel", orderCount: 2, qty: 5, totalPaise: 1000 },
      { type: "dine_in", orderCount: 3, qty: 9, totalPaise: 4000 },
    ];
    expect(channelCards(comparison)).toEqual({
      total: { amountPaise: 5000, orderCount: 5 },
      dineIn: { amountPaise: 4000, orderCount: 3 },
      takeaway: { amountPaise: 1000, orderCount: 2 },
    });
  });

  it("adds a Zomato card, counted in the total, when the comparison has Zomato sales", () => {
    const comparison: OrderTypeAnalytics[] = [
      { type: "parcel", orderCount: 2, qty: 5, totalPaise: 1000 },
      { type: "dine_in", orderCount: 3, qty: 9, totalPaise: 4000 },
      { type: "zomato", orderCount: 1, qty: 2, totalPaise: 580 },
    ];
    expect(channelCards(comparison)).toEqual({
      total: { amountPaise: 5580, orderCount: 6 },
      dineIn: { amountPaise: 4000, orderCount: 3 },
      takeaway: { amountPaise: 1000, orderCount: 2 },
      zomato: { amountPaise: 580, orderCount: 1 },
    });
  });

  it("shows a zero Zomato card while Zomato is on, and none when it is off and unused", () => {
    const zero: OrderTypeAnalytics[] = [{ type: "zomato", orderCount: 0, qty: 0, totalPaise: 0 }];
    expect(channelCards(zero)).not.toHaveProperty("zomato");
    expect(channelCards(zero, true).zomato).toEqual({ amountPaise: 0, orderCount: 0 });
  });

  it("gives zeros for an empty comparison", () => {
    const zero = { amountPaise: 0, orderCount: 0 };
    expect(channelCards([])).toEqual({ total: zero, dineIn: zero, takeaway: zero });
  });
});

describe("orderStats", () => {
  it("counts open and billed orders and passes the bill counts through", () => {
    expect(orderStats({
      billCount: 12, cancelledCount: 2,
      orders: [{ status: "open" }, { status: "open" }, { status: "billed" }, { status: "settled" }, { status: "cancelled" }],
    })).toEqual({ successful: 12, cancelled: 2, inProgress: 2, awaitingPayment: 1 });
  });

  it("is all zero for no activity", () => {
    expect(orderStats({ billCount: 0, cancelledCount: 0, orders: [] })).toEqual({ successful: 0, cancelled: 0, inProgress: 0, awaitingPayment: 0 });
  });
});

describe("aggregatorAlerts", () => {
  const now = 1_790_000_000_000;
  const min = (n: number) => n * 60_000;
  const order = (zomatoOrderId: string | null, openedAt: number, extra: Partial<Order> = {}): Order => ({
    id: `o-${zomatoOrderId}`, type: "zomato", zomatoOrderId, zomatoStatus: null, status: "open", openedAt,
    items: [{ id: "i1", pricePaise: 25000, qty: 1, status: "pending" }],
    ...extra,
  } as Order);

  it("lists open Zomato orders oldest first with status and age text", () => {
    const rows = aggregatorAlerts([
      order("b", now - min(5)),
      order("a", now - min(25), { zomatoStatus: "preparing", items: [{ pricePaise: 9900, qty: 2, status: "sent" }, { pricePaise: 5000, qty: 1, status: "cancelled" }] } as Partial<Order>),
    ], now);
    expect(rows).toEqual([
      { channel: "zomato", orderId: "a", status: "preparing", statusText: "Preparing · 25m", amountPaise: 19800, placedAt: now - min(25) },
      { channel: "zomato", orderId: "b", status: "new", statusText: "New · 5m", amountPaise: 25000, placedAt: now - min(5) },
    ]);
  });

  it("skips other order types and orders that are no longer open, and does not mutate the input", () => {
    const input = [
      order("b", now - min(2), { zomatoStatus: "ready" }),
      order("x", now - min(9), { type: "dine_in" }),
      order("y", now - min(9), { status: "settled", zomatoStatus: "picked_up" }),
      order("z", now - min(9), { status: "cancelled" }),
      order("a", now - min(40), { zomatoStatus: "ready" }),
    ];
    const rows = aggregatorAlerts(input, now);
    expect(rows.map(row => [row.orderId, row.statusText])).toEqual([["a", "Ready · 40m"], ["b", "Ready · 2m"]]);
    expect(input.map(o => o.zomatoOrderId)).toEqual(["b", "x", "y", "z", "a"]);
    expect(aggregatorAlerts([], now)).toEqual([]);
  });

  it("says just now for a brand-new order", () => {
    expect(aggregatorAlerts([order("n", now - 10_000)], now)[0]!.statusText).toBe("New · just now");
  });
});

describe("ageLabel", () => {
  const now = 1_790_000_000_000;
  it("formats elapsed time compactly", () => {
    expect(ageLabel(now - 30_000, now)).toBe("just now");
    expect(ageLabel(now - 12 * 60_000, now)).toBe("12m");
    expect(ageLabel(now - 125 * 60_000, now)).toBe("2h 5m");
    expect(ageLabel(now - 26 * 3_600_000, now)).toBe("1d");
  });

  it("treats future timestamps as just now", () => {
    expect(ageLabel(now + 60_000, now)).toBe("just now");
  });

  it("drops zero minutes on whole hours", () => {
    expect(ageLabel(now - 120 * 60_000, now)).toBe("2h");
  });
});
