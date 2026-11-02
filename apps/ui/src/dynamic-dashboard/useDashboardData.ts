import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardData, DashboardItemValue } from "@masalapos/domain/dashboard";
import { apiFetch } from "../api";
import { withTimeout } from "../abort-signal";
import { useLiveRefresh } from "../live-refresh";
import { isUnavailable } from "./useDashboardLayout";

/** Every server event that can change a widget's figures: orders, kitchen tickets, QR requests, stock and tables. */
export const DASHBOARD_LIVE_EVENTS = ["order.updated", "kot.created", "kot.updated", "guest-request.changed", "stock.changed", "table.changed"] as const;

/**
 * Figures for the widgets on screen, fetched in one request. Nothing is requested while there are no items. A refresh keeps the
 * old figures until the new ones arrive; a failed request keeps the last good results and sets `error`.
 * Only the widget, key and options matter to the request, so moving or resizing a widget does not fetch again.
 */
export function useDashboardData(items: DashboardItemValue[]) {
  const requestKey = useMemo(() => JSON.stringify(items.map((i) => [i.key, i.widget, i.options])), [items]);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [version, setVersion] = useState(0);
  const revision = useRef(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const request = ++revision.current;
    const rows = JSON.parse(requestKey) as Array<[string, string, unknown]>;
    if (rows.length === 0) { setData(null); setError(""); return; }
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 15000);
    const widgets = rows.map(([key, widget, options]) => ({ key, widget, options }));
    apiFetch<DashboardData>("/api/dashboard/data", { method: "POST", body: JSON.stringify({ widgets }), signal })
      .then((next) => {
        if (request !== revision.current) return;
        setData(next); setError("");
      })
      .catch((e) => {
        if (controller.signal.aborted || request !== revision.current) return;
        if (isUnavailable(e)) setUnavailable(true);
        setError(e instanceof Error ? e.message : "Could not load the dashboard");
      });
    return () => { revision.current++; controller.abort(); };
  }, [requestKey, version]);

  useLiveRefresh(refresh, { events: DASHBOARD_LIVE_EVENTS });

  return { data, error, unavailable, refresh };
}
