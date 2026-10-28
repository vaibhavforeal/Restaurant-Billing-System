import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ModuleId, ModuleInfo } from "@forkflow/domain/modules";
import { apiFetch, session } from "./api";
import { connectWs } from "./ws";

interface ModulesValue {
  modules: ModuleInfo[];
  ready: boolean;
  /** The module works now: allowed by ForkFlow, switched on here and its dependencies active. False until loaded. */
  isActive(id: ModuleId): boolean;
  setEnabled(id: ModuleId, enabled: boolean): Promise<void>;
  refresh(): void;
}

const outside: ModulesValue = { modules: [], ready: true, isActive: () => false, setEnabled: () => Promise.reject(new Error("Modules are unavailable")), refresh: () => {} };
const ModulesContext = createContext<ModulesValue>(outside);

export function useModules(): ModulesValue {
  return useContext(ModulesContext);
}

/**
 * One shared copy of the module states, for every signed-in role. It reloads when a module changes, when the licence changes
 * (the ForkFlow owner's allowances arrive in it) and on reconnect. Until the first load everything reads as inactive, and a
 * failed reload keeps the last known states.
 */
export function ModulesProvider({ children }: { children: ReactNode }) {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [ready, setReady] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const result = (await apiFetch<{ modules: ModuleInfo[] }>("/api/modules", { cache: "no-store" })).modules;
      if (request === latest.current) setModules(result);
    } catch { /* keep the last known states */ }
    if (request === latest.current) setReady(true);
  }, []);

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener("forkflow:license-changed", reload);
    const dispose = connectWs({
      onEvent: (event) => { if (event === "modules.changed" || event === "integrations.changed") reload(); },
      onStatus: (connected) => { if (connected) reload(); },
      onAuthFail: () => session.clear(),
    });
    return () => { window.removeEventListener("forkflow:license-changed", reload); dispose(); };
  }, [load]);

  const setEnabled = useCallback(async (id: ModuleId, enabled: boolean) => {
    const result = await apiFetch<{ modules: ModuleInfo[] }>(`/api/modules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    ++latest.current;
    setModules(result.modules);
  }, []);

  const isActive = useCallback((id: ModuleId) => modules.some((m) => m.id === id && m.active), [modules]);
  return <ModulesContext.Provider value={{ modules, ready, isActive, setEnabled, refresh: () => void load() }}>{children}</ModulesContext.Provider>;
}
