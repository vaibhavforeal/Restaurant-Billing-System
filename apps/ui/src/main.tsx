import { startPosPwa } from "./pos-pwa";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./theme.css";
import "./pos-tokens.css";
import "./pos.css";
import "./captain.css";
import { applyTheme, readTheme } from "./theme";
import { startCaptainPwa } from "./captain-pwa";
import { startKitchenPwa } from "./kitchen-pwa";
import { activateOutletIdentity, OUTLET_BINDING_KEY } from "./outlet-identity";
import { StartupScreen } from "./StartupScreen";

// The customer menu has its own restaurant branding and color palette.
if (!/^\/menu\/?$/.test(window.location.pathname)) applyTheme(readTheme());
startCaptainPwa();
startKitchenPwa();
startPosPwa();

function OutletBoot() {
  const [ready, setReady] = useState(false), [error, setError] = useState(""), [archived, setArchived] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReady(false); setError("");
    void fetch("/api/health", { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(8000) }).then(async response => {
      if (!response.ok) throw new Error("The outlet computer did not answer. Check the restaurant network and retry.");
      const health: unknown = await response.json();
      if (!active) return;
      const before = localStorage.getItem(OUTLET_BINDING_KEY), binding = activateOutletIdentity(health);
      setArchived(!!binding?.archiveKey && before !== localStorage.getItem(OUTLET_BINDING_KEY));
      setReady(true);
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "The outlet computer is unavailable."); });
    const changed = (event: StorageEvent) => { if (event.key === OUTLET_BINDING_KEY) location.reload(); };
    const reverify = () => { setReady(false); setAttempt(value => value + 1); };
    window.addEventListener("storage", changed);
    window.addEventListener("forkflow:outlet-identity-changed", reverify);
    return () => { active = false; window.removeEventListener("storage", changed); window.removeEventListener("forkflow:outlet-identity-changed", reverify); };
  }, [attempt]);
  if (error) return <main style={{ maxWidth: 620, margin: "12vh auto", padding: 28 }}><h1>Reconnect to your outlet</h1><p role="alert">{error}</p><p>The application shell is available. Orders and saved actions need a verified connection to the outlet computer.</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></main>;
  if (!ready) return <StartupScreen />;
  return <>{archived && <aside role="status" style={{ padding: "12px 20px", background: "#fff3dd", color: "#785a1c", fontSize: 13 }}>The outlet identity or recovery generation changed. Previous browser data was archived for manual review. Sign in and check current orders before taking new actions. <button onClick={() => setArchived(false)}>Dismiss</button></aside>}<App /></>;
}
createRoot(document.getElementById("root")!).render(<OutletBoot />);
