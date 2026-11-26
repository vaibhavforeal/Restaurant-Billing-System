import { COUNTER_PAYMENT_MODES, type CounterPaymentMode, type Database } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";

/** Whether the restaurant has Hold orders on (Settings → Restaurant profile). */
export function holdOrdersEnabled(db: Database): boolean {
  return (db.prepare("SELECT hold_orders_enabled AS v FROM settings WHERE id = 1").get() as { v: number }).v === 1;
}

export interface OrderSettings {
  holdOrders: boolean;
  /** An open order turns amber, then red, on the order board after this many minutes. */
  orderWarnMinutes: number;
  orderLateMinutes: number;
  /** The payment methods the counter takes, in bill order. */
  paymentModes: CounterPaymentMode[];
  /** The hour (0-6) the business day starts, so screens show the same "today" as the reports. */
  dayStartHour: number;
}

export function orderSettings(db: Database): OrderSettings {
  const r = db.prepare("SELECT hold_orders_enabled, order_warn_minutes, order_late_minutes, pay_cash_enabled, pay_card_enabled, pay_upi_enabled, day_start_hour FROM settings WHERE id = 1")
    .get() as { hold_orders_enabled: number; order_warn_minutes: number; order_late_minutes: number; pay_cash_enabled: number; pay_card_enabled: number; pay_upi_enabled: number; day_start_hour: number };
  return { holdOrders: r.hold_orders_enabled === 1, orderWarnMinutes: r.order_warn_minutes, orderLateMinutes: r.order_late_minutes,
    paymentModes: COUNTER_PAYMENT_MODES.filter((mode) => r[`pay_${mode}_enabled`] === 1), dayStartHour: r.day_start_hour };
}

/** Order screens and captain tablets read the ordering options here; `/api/settings` needs `settings.manage`. */
export function registerOrderSettings(app: FastifyInstance): void {
  app.get("/api/order-settings", { preHandler: app.requirePermission("orders.read") }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return orderSettings(app.db);
  });
}
