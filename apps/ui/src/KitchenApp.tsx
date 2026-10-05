import { useEffect, useState } from "react";
import { ApiError, apiFetch, session, type User } from "./api";
import { Kitchen } from "./screens/Kitchen";
import { Login } from "./screens/Login";
import { LicenseGate } from "./screens/LicenseSettings";
import { ThemeToggle } from "./ThemeToggle";
import { DemoBanner } from "./DemoBanner";
import { KitchenInstall } from "./kitchen-pwa";
import "./kitchen-app.css";

export function KitchenApp() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  function enter(next: User) {
    if (next.role === "waiter") { session.clear(); setError("Use a kitchen, cashier or admin PIN for this display."); return; }
    setError(""); setUser(next);
  }
  useEffect(() => {
    let active = true;
    session.onUnauthorized = () => { if (active) setUser(null); };
    void (async () => {
      try {
        const info = await apiFetch<{ needsSetup: boolean; demo?: boolean }>("/api/needs-setup");
        if (!active) return;
        setDemo(!!info.demo);
        if (info.needsSetup) { setError("Finish restaurant setup on the main POS, then reload this display."); return; }
        if (session.token) {
          const result = await apiFetch<{ user: User }>("/api/me");
          if (active) enter(result.user);
        }
      } catch (error) {
        if (active && !(error instanceof ApiError && error.status === 401)) setError("Cannot reach the main POS. Check the restaurant network and retry.");
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; session.onUnauthorized = null; };
  }, []);
  async function logout() {
    if (busy) return;
    setBusy(true);
    try { await apiFetch("/api/logout", { method: "POST" }); }
    catch { /* Local sign-out is available during a network interruption. */ }
    finally { session.clear(); setUser(null); setBusy(false); }
  }
  if (loading) return <main className="kitchen-start" role="status">Connecting to the main POS…</main>;
  if (!user) return <><DemoBanner demo={demo} login />
    {error && <div className="kitchen-start"><p role="alert">{error}</p><button onClick={() => location.reload()}>Retry connection</button></div>}
    <Login kitchen onLogin={enter} />
    <footer className="kitchen-start">Main POS: {location.host}<KitchenInstall /></footer>
  </>;
  return <div className="kitchen-app"><DemoBanner demo={demo} />
    <header className="kitchen-app-header"><div><strong>ForkFlow Kitchen</strong><small>Main POS: {location.host}</small></div>
      <div className="actions"><span>{user.name}</span><ThemeToggle /><KitchenInstall />
        <button disabled={busy} onClick={() => void logout()}>Sign out</button></div></header>
    <LicenseGate user={user}><main id="main-content" className="kitchen-app-main"><Kitchen standalone onBusyChange={setBusy} /></main></LicenseGate>
  </div>;
}
