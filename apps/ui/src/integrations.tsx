import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IntegrationId, IntegrationInfo } from "@forkflow/domain/integrations";
import { ApiError, apiFetch, session, type User } from "./api";
import { isEnabled as listHas, nextList } from "./integrations-model";
import { connectWs } from "./ws";

interface IntegrationsValue {
  integrations: IntegrationInfo[];
  ready: boolean;
  isEnabled(id: IntegrationId): boolean;
  setEnabled(id: IntegrationId, enabled: boolean): Promise<void>;
  refresh(): void;
}

const outside: IntegrationsValue = { integrations: [], ready: true, isEnabled: () => false, setEnabled: () => Promise.reject(new Error("Integrations are unavailable")), refresh: () => {} };
const IntegrationsContext = createContext<IntegrationsValue>(outside);

export function useIntegrations(): IntegrationsValue {
  return useContext(IntegrationsContext);
}

/** One shared copy of the Marketplace state. Only admin and cashier can read it; other roles get an empty list. */
export function IntegrationsProvider({ user, children }: { user: User; children: ReactNode }) {
  const allowed = user.role === "admin" || user.role === "cashier";
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [ready, setReady] = useState(!allowed);
  const latest = useRef(0);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    const request = ++latest.current;
    let result: IntegrationInfo[] | null = null;
    try {
      result = (await apiFetch<{ integrations: IntegrationInfo[] }>("/api/integrations", { cache: "no-store" })).integrations;
    } catch {
      // Fail closed until the first successful load; after that a failed refetch keeps the last known list.
    }
    if (request === latest.current) {
      if (result) loadedOnce.current = true;
      setIntegrations((prev) => nextList(prev, result, loadedOnce.current));
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
    // `licensed` comes from the installation's licence, so a licence import or expiry changes the list too.
    const licenseChanged = () => void load();
    window.addEventListener("forkflow:license-changed", licenseChanged);
    const dispose = connectWs({
      onEvent: (event) => { if (event === "integrations.changed") void load(); },
      onStatus: (connected) => { if (connected) void load(); },
      onAuthFail: () => session.clear(),
    });
    return () => { window.removeEventListener("forkflow:license-changed", licenseChanged); dispose(); };
  }, [allowed, load]);

  const setEnabled = useCallback(async (id: IntegrationId, enabled: boolean) => {
    try {
      const { integration } = await apiFetch<{ integration: IntegrationInfo }>(`/api/integrations/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      loadedOnce.current = true;
      latest.current++; // an older in-flight list must not overwrite this result
      setIntegrations((list) => list.map((entry) => (entry.id === id ? integration : entry)));
    } catch (error) {
      throw new Error(error instanceof ApiError || error instanceof Error ? error.message : "Could not update the integration");
    }
  }, []);

  const value = useMemo<IntegrationsValue>(() => ({
    integrations, ready,
    isEnabled: (id) => listHas(integrations, id),
    setEnabled,
    refresh: () => void load(),
  }), [integrations, ready, setEnabled, load]);

  return <IntegrationsContext.Provider value={value}>{children}</IntegrationsContext.Provider>;
}
