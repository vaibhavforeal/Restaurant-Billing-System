import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { apiFetch, session } from "./api";
import type { SalesReport } from "./sales-report";
import type { Order } from "./types";
import { connectWs } from "./ws";

export interface DashboardDayEnd { sales: { billCount: number }; cancellations: { orderCount: number } }
interface DashboardData {
  date: string;
  analytics: { dineIn: OrderAnalyticsReport; takeaway: OrderAnalyticsReport } | null;
  dayEnd: DashboardDayEnd | null;
  sales: SalesReport | null;
  orders: Order[];
  /** When every request for this date last succeeded. */
  updatedAt: number | null;
}

const message = (reason: unknown) => reason instanceof Error ? reason.message : "Could not load the dashboard";

/** A timestamp that advances every `intervalMs`, for "N min ago" labels and day rollover. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Everything the Home dashboard shows for one bill date. A refresh of the same date keeps the previous figures on
 * screen until the new ones arrive; a failed request sets `error` and keeps whatever else loaded.
 */
export function useDashboard(date: string) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const revision = useRef(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const request = ++revision.current;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    setLoading(true);
    const day = encodeURIComponent(date);
    const get = <T,>(path: string) => apiFetch<T>(path, { signal, cache: "no-store" });
    void Promise.allSettled([
      get<{ report: OrderAnalyticsReport }>(`/api/reports/analytics?from=${day}&to=${day}&type=dine_in`),
      get<{ report: OrderAnalyticsReport }>(`/api/reports/analytics?from=${day}&to=${day}&type=parcel`),
      get<{ report: DashboardDayEnd }>(`/api/reports/day-end?date=${day}`),
      get<{ report: SalesReport }>(`/api/reports/sales?from=${day}&to=${day}`),
      get<{ orders: Order[] }>("/api/orders"),
    ]).then(([dineIn, takeaway, dayEnd, sales, orders]) => {
      if (controller.signal.aborted || request !== revision.current) return;
      const results = [dineIn, takeaway, dayEnd, sales, orders] as PromiseSettledResult<unknown>[];
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      setData((previous) => {
        // Keep the last good value for this date when one request fails; never show another date's figures.
        const kept = previous?.date === date ? previous : null;
        return {
          date,
          analytics: dineIn.status === "fulfilled" && takeaway.status === "fulfilled"
            ? { dineIn: dineIn.value.report, takeaway: takeaway.value.report } : kept?.analytics ?? null,
          dayEnd: dayEnd.status === "fulfilled" ? dayEnd.value.report : kept?.dayEnd ?? null,
          sales: sales.status === "fulfilled" ? sales.value.report : kept?.sales ?? null,
          orders: orders.status === "fulfilled" ? orders.value.orders : kept?.orders ?? [],
          updatedAt: failed ? kept?.updatedAt ?? null : Date.now(),
        };
      });
      setError(failed ? message(failed.reason) : "");
      setLoading(false);
    });
    return () => { revision.current++; controller.abort(); };
  }, [date, version]);

  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    const schedule = () => { clearTimeout(scheduled); scheduled = setTimeout(refresh, 400); };
    const stop = connectWs({
      onEvent: (event) => { if (event === "order.updated") schedule(); },
      onStatus: (connected) => { if (connected) { if (connectedOnce) schedule(); connectedOnce = true; } },
      onAuthFail: () => session.clear(),
    });
    const timer = setInterval(refresh, 60000);
    return () => { stop(); clearTimeout(scheduled); clearInterval(timer); };
  }, [refresh]);

  const current = data?.date === date ? data : null;
  return {
    analytics: current?.analytics ?? null,
    dayEnd: current?.dayEnd ?? null,
    sales: current?.sales ?? null,
    orders: current?.orders ?? [],
    error, loading, updatedAt: current?.updatedAt ?? null, refresh,
  };
}
