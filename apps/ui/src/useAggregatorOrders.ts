import { useCallback, useEffect, useRef, useState } from "react";
import type { ZomatoOrder } from "@forkflow/domain/zomato";
import { ApiError, apiFetch } from "./api";
import { aggregatorAlerts, type AlertRow } from "./dashboard-data";
import { connectWs } from "./ws";

const none: AlertRow[] = [];
interface AggregatorOrders { rows: AlertRow[]; truncated: boolean; error: string; loaded: boolean }
const idle: AggregatorOrders = { rows: none, truncated: false, error: "", loaded: false };

/**
 * Open aggregator orders for the dashboard Alerts panel. Only Zomato exists today. When `enabled` is false nothing is
 * requested and no rows are returned. A failure keeps the last rows and sets `error`; it never throws. `loaded` turns true
 * once the first request has finished, either way, so the panel does not claim "no orders" before it knows.
 */
export function useAggregatorOrders(enabled: boolean): AggregatorOrders {
  const [state, setState] = useState<AggregatorOrders>(idle);
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const request = ++revision.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    try {
      const { orders, truncated } = await apiFetch<{ orders: ZomatoOrder[]; truncated: boolean }>("/api/zomato/orders", {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]), cache: "no-store",
      });
      if (request === revision.current) setState({ rows: aggregatorAlerts(orders), truncated, error: "", loaded: true });
    } catch (error) {
      if (current.signal.aborted || request !== revision.current) return;
      const text = error instanceof ApiError && error.status === 403 ? "You do not have access to Zomato orders."
        : `Zomato orders could not be loaded${error instanceof Error && error.message ? `: ${error.message}` : ""}.`;
      setState((previous) => ({ ...previous, error: text, loaded: true }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      revision.current++; controller.current?.abort();
      setState(idle);
      return;
    }
    void load();
    let connectedOnce = false;
    const stop = connectWs({
      onEvent: (event) => { if (event === "zomato.changed") void load(); },
      onStatus: (connected) => { if (connected) { if (connectedOnce) void load(); connectedOnce = true; } },
    });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => { stop(); window.clearInterval(timer); revision.current++; controller.current?.abort(); };
  }, [enabled, load]);

  return enabled ? state : idle;
}
