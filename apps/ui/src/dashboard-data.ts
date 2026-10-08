import type { AnalyticsHour, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import type { ZomatoOrder } from "@forkflow/domain/zomato";
import type { Order } from "./types";

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

export interface SlotBar { label: string; dineInPaise: number; takeawayPaise: number; totalPaise: number }

export function slotBars(dineIn: AnalyticsHour[], takeaway: AnalyticsHour[]): SlotBar[] {
  const bars: SlotBar[] = SLOTS.map(slot => ({ label: slot.label, dineInPaise: 0, takeawayPaise: 0, totalPaise: 0 }));
  const add = (rows: AnalyticsHour[], key: "dineInPaise" | "takeawayPaise") => {
    for (const row of rows) {
      if (!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23) continue;
      const bar = bars[slotIndex(row.hour)]!;
      bar[key] += row.totalPaise;
      bar.totalPaise += row.totalPaise;
    }
  };
  add(dineIn, "dineInPaise");
  add(takeaway, "takeawayPaise");
  return bars;
}

export interface ChannelCard { amountPaise: number; orderCount: number }

export function channelCards(comparison: OrderTypeAnalytics[]): { total: ChannelCard; dineIn: ChannelCard; takeaway: ChannelCard } {
  const card = (type: OrderTypeAnalytics["type"]): ChannelCard => {
    let amountPaise = 0, orderCount = 0;
    for (const row of comparison) if (row.type === type) { amountPaise += row.totalPaise; orderCount += row.orderCount; }
    return { amountPaise, orderCount };
  };
  const dineIn = card("dine_in"), takeaway = card("parcel");
  return {
    total: { amountPaise: dineIn.amountPaise + takeaway.amountPaise, orderCount: dineIn.orderCount + takeaway.orderCount },
    dineIn,
    takeaway,
  };
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

export type AlertRow = {
  channel: "zomato" | "swiggy"; orderId: string; status: string; amountPaise: number; placedAt: number;
  paymentMode: "prepaid" | "cod" | "unknown";
};

/** Oldest first, so the order waiting longest is at the top. Only Zomato exists today. */
export function aggregatorAlerts(zomato: ZomatoOrder[]): AlertRow[] {
  return zomato
    .map((order): AlertRow => ({
      channel: "zomato", orderId: order.orderId, status: order.status, amountPaise: order.totalPaise,
      placedAt: order.placedAt, paymentMode: order.paymentMode,
    }))
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
