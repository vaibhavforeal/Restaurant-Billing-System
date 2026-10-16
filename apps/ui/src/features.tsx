import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FeatureCatalog } from "@forkflow/domain";
import { apiFetch, session } from "./api";
import { connectWs } from "./ws";
import { FeaturesStore } from "./features-store";

const FeatureContext = createContext<FeaturesStore | null>(null);
const empty = { catalog: null, ready: false, error: "" };
const noSubscribe = () => () => {};
export function useFeatures() {
  const store = useContext(FeatureContext);
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? (() => empty));
  return { ...snapshot, isActive: (id: string) => store?.isActive(id) ?? true, setEnabled: (id: string, enabled: boolean) => store ? store.setEnabled(id, enabled) : Promise.reject(new Error("Features unavailable")), refresh: () => void store?.refresh() };
}
export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new FeaturesStore((path, init) => apiFetch<FeatureCatalog>(path, init)));
  useEffect(() => {
    void store.refresh();
    const refresh = () => void store.refresh();
    window.addEventListener("forkflow:license-changed", refresh);
    window.addEventListener("focus", refresh);
    const disposeWs = connectWs({ onEvent: event => { if (event === "features.changed" || event === "integrations.changed") refresh(); }, onStatus: connected => { if (connected) refresh(); }, onAuthFail: () => session.clear() });
    return () => { window.removeEventListener("forkflow:license-changed", refresh); window.removeEventListener("focus", refresh); disposeWs(); store.dispose(); };
  }, [store]);
  return <FeatureContext.Provider value={store}>{children}</FeatureContext.Provider>;
}
export function FeatureNotice({ id }: { id: string }) {
  const { catalog, ready, error, refresh } = useFeatures();
  const info = catalog?.features.find(feature => feature.id === id);
  return <div className="panel" role="status"><h3>{info?.name ?? "Feature"} {ready ? "is unavailable" : "is loading"}</h3><p>{error || info?.reason || "Checking feature availability…"}</p>{ready && <p>Contact ForkFlow to change feature availability. Existing records and drafts are retained.</p>}<button onClick={refresh}>Refresh features</button></div>;
}
/** Keep the mounted workspace and its drafts; switch off interaction and polling at the subsystem level. */
export function FeatureWorkspace({ id, children }: { id: string; children: ReactNode }) {
  const { isActive } = useFeatures();
  const active = isActive(id);
  const started = useRef(false);
  if (active) started.current = true;
  // Delay initial mount so loading/disabled modules cannot start writes. Once
  // opened, retain their component state and drafts across availability changes.
  return <>{!active && <FeatureNotice id={id} />}<div hidden={!active} inert={!active}>{started.current && children}</div></>;
}
