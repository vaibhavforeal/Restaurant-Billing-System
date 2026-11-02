import { useCallback, useEffect, useState } from "react";
import type { DashboardLayoutValue } from "@masalapos/domain/dashboard";
import { ApiError, apiFetch } from "../api";

export interface LayoutResponse { layout: DashboardLayoutValue; isDefault: boolean }

/**
 * True when the feature itself is off or the user lost the permission: a 409, a `module_off` code, or the auth layer's
 * "forbidden". Any other failure (a 400, or a 403 saying one widget is not allowed) is an ordinary error.
 */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 409 || e.code === "module_off" || (e.status === 403 && e.message === "forbidden"));
}

/**
 * The saved dashboard layout. `load`, `save` and `reset` update the state from the server's answer and return it; on failure
 * they throw the error so the screen can stay in edit mode and show it. `unavailable` turns on when a call says the feature is
 * off. A save the server refuses for another reason reloads the layout so the screen catches up with the server.
 */
export function useDashboardLayout() {
  const [state, setState] = useState<LayoutResponse | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);

  const call = useCallback(async (init?: RequestInit) => {
    try {
      const next = await apiFetch<LayoutResponse>("/api/dashboard/layout", init);
      setState(next);
      return next;
    } catch (e) {
      if (isUnavailable(e)) setUnavailable(true);
      throw e;
    }
  }, []);

  const load = useCallback(() => call({ cache: "no-store" }), [call]);

  useEffect(() => {
    const controller = new AbortController();
    call({ signal: controller.signal, cache: "no-store" })
      .then(() => setError(""))
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the dashboard"); });
    return () => controller.abort();
  }, [call]);

  const save = useCallback(async (layout: DashboardLayoutValue) => {
    try { return await call({ method: "PUT", body: JSON.stringify({ layout }) }); }
    catch (e) {
      if (!isUnavailable(e) && e instanceof ApiError && e.status === 403) await load().catch(() => undefined);
      throw e;
    }
  }, [call, load]);
  const reset = useCallback(() => call({ method: "DELETE" }), [call]);

  return { layout: state?.layout ?? null, isDefault: state?.isDefault ?? true, error, unavailable, load, save, reset };
}
