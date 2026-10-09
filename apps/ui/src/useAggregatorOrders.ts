import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch } from "./api";
import { aggregatorAlerts, type AlertRow } from "./dashboard-data";
import type { Order } from "./types";
import { useNow } from "./useDashboard";
import { connectWs } from "./ws";

const none: AlertRow[] = [];
interface AggregatorOrders { rows: AlertRow[]; error: string; loaded: boolean }
interface Loaded { orders: Order[]; error: string; loaded: boolean }
const noOrders: Order[] = [];
const idle: AggregatorOrders = { rows: none, error: "", loaded: false };
const idleLoaded: Loaded = { orders: noOrders, error: "", loaded: false };

/**
 * Open aggregator orders for the dashboard Alerts panel, taken from the POS orders (`GET /api/orders`) and refreshed on
 * every `order.updated`. Only Zomato exists today. When `enabled` is false nothing is requested and no rows are returned. A failure keeps the last rows and sets `error`; it never throws. `loaded` turns true
 * once the first request has finished, either way, so the panel does not claim "no orders" before it knows.
 */
export function useAggregatorOrders(enabled: boolean): AggregatorOrders {
  const [state, setState] = useState<Loaded>(idleLoaded);
  const now = useNow(30_000);
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const request = ++revision.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    try {
      const { orders } = await apiFetch<{ orders: Order[] }>("/api/orders", {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]), cache: "no-store",
      });
      if (request === revision.current) setState({ orders, error: "", loaded: true });
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
      setState(idleLoaded);
      return;
    }
    void load();
    let connectedOnce = false;
    const stop = connectWs({
      onEvent: (event) => { if (event === "order.updated") void load(); },
      onStatus: (connected) => { if (connected) { if (connectedOnce) void load(); connectedOnce = true; } },
    });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => { stop(); window.clearInterval(timer); revision.current++; controller.current?.abort(); };
  }, [enabled, load]);

  const rows = useMemo(() => aggregatorAlerts(state.orders, now), [state.orders, now]);
  return enabled ? { rows, error: state.error, loaded: state.loaded } : idle;
}
