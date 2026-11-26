import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { PaymentMode } from "./device-preferences";
import { setDayStartHour } from "./sales-report";
import { connectWs } from "./ws";

/** The restaurant's ordering options any signed-in staff screen may read (`/api/settings` is for admins). */
export interface OrderSettings {
  holdOrders: boolean;
  /** An open order turns amber, then red, on the order board after this many minutes. */
  orderWarnMinutes: number;
  orderLateMinutes: number;
  /** The payment methods the counter takes, in bill order. */
  paymentModes: PaymentMode[];
  /** The hour (0-6) the business day starts. */
  dayStartHour: number;
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = {
  holdOrders: true, orderWarnMinutes: 15, orderLateMinutes: 25, paymentModes: ["cash", "card", "upi"], dayStartHour: 0,
};

/**
 * The ordering options, reloaded when Settings change or the connection comes back. Until the first load, or when it
 * fails, the screen keeps the defaults or the last values it had. Each load also sets the business day's start hour for
 * the report screens' "today".
 */
export function useOrderSettings(): OrderSettings {
  const [settings, setSettings] = useState(DEFAULT_ORDER_SETTINGS);
  useEffect(() => {
    let alive = true;
    const load = () => apiFetch<OrderSettings>("/api/order-settings", { cache: "no-store" })
      .then((next) => { if (!alive) return; setSettings(next); setDayStartHour(next.dayStartHour); })
      .catch(() => { /* Keep the last known options. */ });
    void load();
    const disconnect = connectWs({
      onEvent: (event) => { if (event === "settings.changed") void load(); },
      onStatus: (connected) => { if (connected) void load(); },
    });
    return () => { alive = false; disconnect(); };
  }, []);
  return settings;
}

/** Keeps the business day's start hour current for screens that show report dates; renders nothing. */
export function BusinessDaySync() {
  useOrderSettings();
  return null;
}
