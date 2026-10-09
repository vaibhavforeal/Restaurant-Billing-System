import type { AnalyticsHour, OrderAnalyticsReport, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import { statusText } from "./dashboard-view";
import type { Order } from "./types";

type OrderTypeReport = Pick<OrderAnalyticsReport, "hourly">;

/** Four-hour dashboard slots. The last one wraps midnight: 21:00-01:00 includes the 00:00-00:59 hour. */
export const SLOTS: readonly { label: string }[] = [
  { label: "01:00am - 05:00am" },
  { label: "05:00am - 09:00am" },
  { label: "09:00am - 01:00pm" },
  { label: "01:00pm - 05:00pm" },
  { label: "05:00pm - 09:00pm" },
  { label: "09:00pm - 01:00am" },
];

export function slotIndex(hour: number): number {
  return Math.floor(((hour + 23) % 24) / 4);
}

export interface SlotBar { label: string; dineInPaise: number; takeawayPaise: number; zomatoPaise: number; totalPaise: number }

/** `zomato` is the separate `type=zomato` report; the "all" view has no Zomato split, so it is optional. */
export function slotBars(dineIn: AnalyticsHour[], takeaway: AnalyticsHour[], zomato?: Pick<OrderTypeReport, "hourly"> | null): SlotBar[] {
  const bars: SlotBar[] = SLOTS.map(slot => ({ label: slot.label, dineInPaise: 0, takeawayPaise: 0, zomatoPaise: 0, totalPaise: 0 }));
  const add = (rows: AnalyticsHour[], key: "dineInPaise" | "takeawayPaise" | "zomatoPaise") => {
    for (const row of rows) {
      if (!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23) continue;
      const bar = bars[slotIndex(row.hour)]!;
      bar[key] += row.totalPaise;
      bar.totalPaise += row.totalPaise;
    }
  };
  add(dineIn, "dineInPaise");
  add(takeaway, "takeawayPaise");
  add(zomato?.hourly ?? [], "zomatoPaise");
  return bars;
}

export interface ChannelCard { amountPaise: number; orderCount: number }

/**
 * Total, Dine In and Takeaway cards, plus a Zomato card when Zomato is on (`showZomato`) or the comparison already
 * holds Zomato sales for the day. The total counts every order type, so it always equals the sum of the cards shown.
 */
export function channelCards(comparison: OrderTypeAnalytics[], showZomato = false):
  { total: ChannelCard; dineIn: ChannelCard; takeaway: ChannelCard; zomato?: ChannelCard } {
  const card = (type: OrderTypeAnalytics["type"]): ChannelCard => {
    let amountPaise = 0, orderCount = 0;
    for (const row of comparison) if (row.type === type) { amountPaise += row.totalPaise; orderCount += row.orderCount; }
    return { amountPaise, orderCount };
  };
  const dineIn = card("dine_in"), takeaway = card("parcel"), zomato = card("zomato");
  const total = {
    amountPaise: dineIn.amountPaise + takeaway.amountPaise + zomato.amountPaise,
    orderCount: dineIn.orderCount + takeaway.orderCount + zomato.orderCount,
  };
  return showZomato || zomato.amountPaise !== 0 || zomato.orderCount !== 0 ? { total, dineIn, takeaway, zomato } : { total, dineIn, takeaway };
}

export function orderStats(input: { billCount: number; cancelledCount: number; orders: Pick<Order, "status">[] }):
  { successful: number; cancelled: number; inProgress: number; awaitingPayment: number } {
  return {
    successful: input.billCount,
    cancelled: input.cancelledCount,
    inProgress: input.orders.filter(order => order.status === "open").length,
    awaitingPayment: input.orders.filter(order => order.status === "billed").length,
  };
}

/** `status` is the Zomato desk status ("new" before the first press); `statusText` is the line shown, e.g. "Preparing · 25m". */
export type AlertRow = {
  channel: "zomato" | "swiggy"; orderId: string; status: string; statusText: string; amountPaise: number; placedAt: number;
};

/** Open Zomato orders from the POS, oldest first, so the order waiting longest is at the top. Only Zomato exists today. */
export function aggregatorAlerts(orders: Order[], now: number): AlertRow[] {
  return orders
    .filter(order => order.type === "zomato" && order.status === "open")
    .map((order): AlertRow => {
      const status = order.zomatoStatus ?? "new";
      return {
        channel: "zomato", orderId: order.zomatoOrderId ?? "", status,
        statusText: `${statusText(status)} · ${ageLabel(order.openedAt, now)}`,
        // Zomato bills carry no GST and no discount, so the order total is the sum of its live lines.
        amountPaise: order.items.reduce((sum, item) => item.status === "cancelled" ? sum : sum + item.pricePaise * item.qty, 0),
        placedAt: order.openedAt,
      };
    })
    .sort((a, b) => a.placedAt - b.placedAt);
}

export function ageLabel(placedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - placedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
