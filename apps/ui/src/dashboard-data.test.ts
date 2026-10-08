import { describe, expect, it } from "vitest";
import type { AnalyticsHour, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import type { ZomatoOrder } from "@forkflow/domain/zomato";
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
  const order = (orderId: string, placedAt: number, extra: Partial<ZomatoOrder> = {}): ZomatoOrder => ({
    restaurantId: "r1", orderId, placedAt, status: "received", totalPaise: 25000, paymentMode: "prepaid", items: [],
    source: "webhook", updatedAt: placedAt, ...extra,
  });

  it("maps zomato orders to rows, oldest first", () => {
    const rows = aggregatorAlerts([order("b", 2000), order("a", 1000, { status: "preparing", paymentMode: "cod", totalPaise: 9900 })]);
    expect(rows).toEqual([
      { channel: "zomato", orderId: "a", status: "preparing", amountPaise: 9900, placedAt: 1000, paymentMode: "cod" },
      { channel: "zomato", orderId: "b", status: "received", amountPaise: 25000, placedAt: 2000, paymentMode: "prepaid" },
    ]);
  });

  it("keeps an order with no items and an unknown payment mode, without mutating the input", () => {
    const input = [order("b", 2000), order("a", 1000, { paymentMode: "unknown" })];
    const rows = aggregatorAlerts(input);
    expect(rows.map(row => row.orderId)).toEqual(["a", "b"]);
    expect(rows[0]!.paymentMode).toBe("unknown");
    expect(input.map(o => o.orderId)).toEqual(["b", "a"]);
    expect(aggregatorAlerts([])).toEqual([]);
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
