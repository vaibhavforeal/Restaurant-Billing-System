import { useCallback, useEffect, useState } from "react";
import type { DashboardLayoutValue } from "@masalapos/domain/dashboard";
import { ApiError, apiFetch } from "../api";

interface LayoutResponse { layout: DashboardLayoutValue; isDefault: boolean }

/** A 403 or 409 means the feature is off or the permission is gone, not a passing failure. */
export const isUnavailable = (e: unknown): boolean => e instanceof ApiError && (e.status === 403 || e.status === 409);

/**
 * The saved dashboard layout. `save` and `reset` update the state from the server's answer and throw the error on failure,
 * so the screen can stay in edit mode and show it. `unavailable` turns on when any call says the feature is not allowed.
 */
export function useDashboardLayout() {
  const [state, setState] = useState<LayoutResponse | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);

  const call = useCallback(async (init?: RequestInit) => {
    try {
      const next = await apiFetch<LayoutResponse>("/api/dashboard/layout", init);
      setState(next);
    } catch (e) {
      if (isUnavailable(e)) setUnavailable(true);
      throw e;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    call({ signal: controller.signal, cache: "no-store" })
      .then(() => setError(""))
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the dashboard"); });
    return () => controller.abort();
  }, [call]);

  const save = useCallback((layout: DashboardLayoutValue) => call({ method: "PUT", body: JSON.stringify({ layout }) }), [call]);
  const reset = useCallback(() => call({ method: "DELETE" }), [call]);

  return { layout: state?.layout ?? null, isDefault: state?.isDefault ?? true, error, unavailable, save, reset };
}
