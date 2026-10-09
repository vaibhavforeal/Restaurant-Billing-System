import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, session, type User } from "./api";
import { NavBar, type Page } from "./NavBar";
import { Catalog } from "./screens/Catalog";
import { Home } from "./screens/Home";
import { Kitchen } from "./screens/Kitchen";
import { Login } from "./screens/Login";
import { OrderScreen } from "./screens/OrderScreen";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { Tables } from "./screens/Tables";
import { Users } from "./screens/Users";
import { Bills } from "./screens/Bills";
import { SalesReports } from "./screens/SalesReports";
import { Inventory } from "./screens/Inventory";
import { IntegrationOff, Marketplace } from "./screens/Marketplace";
import { IntegrationsProvider, useIntegrations } from "./integrations";
import { ConnectionStatus } from "./ConnectionStatus";
import { LicenseGate } from "./screens/LicenseSettings";
import { NavigationGuardContext, type NavigationGuard } from "./navigation-guard";
import { GuestMenu } from "./screens/GuestMenu";
import { QuickTakeaway, releaseHeldTakeaway } from "./screens/QuickTakeaway";
import { QrNotifications } from "./QrNotifications";
import { usePosShortcuts } from "./pos-shortcuts";
import { CaptainNav } from "./CaptainNav";
import { CaptainReconnect } from "./CaptainInstall";
import { isCaptainPath } from "./captain-pwa";
import { StartupScreen } from "./StartupScreen";
import { KitchenApp } from "./KitchenApp";
import { DemoBanner } from "./DemoBanner";
import { canReconcileZomato } from "./zomato-desk";
import "./compact-workspace.css";

type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "offline" }
  | { kind: "in"; user: User; page: Page };


export function App() {
  const [guestToken, setGuestToken] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const change = () => setGuestToken(window.location.hash.slice(1));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  if (window.location.pathname === "/menu" || window.location.pathname === "/menu/") {
    return <GuestMenu token={guestToken} />;
  }
  if (/^\/kitchen\/?$/.test(window.location.pathname)) return <KitchenApp />;
  return <StaffApp />;
}

/** Admins and cashiers reach the kitchen board only while the Kitchen Display is on. Kitchen staff cannot read the Marketplace, so their board explains a turned-off KDS itself. */
function KitchenRoute({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { ready, isEnabled } = useIntegrations();
  if (user.role === "kitchen") return <Kitchen />;
  if (!ready) return <p role="status">Loading kitchen display…</p>;
  if (!isEnabled("kds")) return <IntegrationOff name="Kitchen Display" canManage={user.role === "admin"} onOpenMarketplace={() => onNavigate({ name: "marketplace" })} />;
  return <Kitchen />;
}

function StaffApp() {
  usePosShortcuts();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [demo, setDemo] = useState(false);
  const navigationGuard = useRef(new Set<NavigationGuard>());
  const captainEntry = isCaptainPath();
  function enter(user: User) {
    if (user.role === "waiter" && !captainEntry) { window.location.replace("/captain/"); return; }
    const page: Page = user.role === "kitchen" ? { name: "kitchen" } : captainEntry || user.role === "waiter" ? { name: "tables" } : { name: "home" };
    setState({ kind: "in", user, page });
  }
  const pageKey = state.kind === "in" ? state.page.name === "order" ? state.page.orderId : state.page.name : state.kind;
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [pageKey]);

  useEffect(() => {
    // Register expiry handler
    session.onUnauthorized = () => setState({ kind: "login" });

    void (async () => {
      try {
        const { needsSetup, demo } = await apiFetch<{ needsSetup: boolean; demo?: boolean }>("/api/needs-setup");
        setDemo(!!demo);
        if (needsSetup) return setState({ kind: "setup" });
        if (session.token) {
          try {
            const { user } = await apiFetch<{ user: User }>("/api/me");
            return enter(user);
          } catch (error) {
            if (captainEntry && !(error instanceof ApiError && error.status === 401)) return setState({ kind: "offline" });
            /* token expired — fall through to login */
          }
        }
        setState({ kind: "login" });
      } catch {
        setState({ kind: captainEntry ? "offline" : "login" });
      }
    })();

    return () => {
      session.onUnauthorized = null;
    };
  }, []);

  switch (state.kind) {
    case "loading":
      return <StartupScreen />;
    case "setup":
      return <Setup onDone={(user) => setState({ kind: "in", user, page: { name: "home" } })} />;
    case "login":
      return <><DemoBanner demo={demo} login /><Login captain={captainEntry} onLogin={enter} /></>;
    case "offline":
      return <CaptainReconnect />;
    case "in": {
      const { user, page } = state;
      const captain = user.role === "waiter" || (captainEntry && user.role !== "kitchen");
      const canQuickBill = !captain && (user.role === "admin" || user.role === "cashier");
      const canLeave = () => Array.from(navigationGuard.current).every(guard => guard());
      const go = (next: Page) => { if ((next.name !== "takeaway" || canQuickBill) && canLeave()) setState({ kind: "in", user, page: next }); };
      const onOpenOrder = (orderId: string) => setState({ kind: "in", user, page: { name: "order", orderId } });
      const onBack = () => setState({ kind: "in", user, page: { name: "tables" } });
      return (
        <NavigationGuardContext.Provider value={navigationGuard}><IntegrationsProvider key={user.id} user={user}><div className={`app-shell${captain ? " captain-shell" : ""}${page.name === "tables" || page.name === "order" || page.name === "takeaway" ? " compact-workspace" : ""}${page.name === "tables" ? " tables-workspace" : page.name === "order" || page.name === "takeaway" ? " order-workspace" : ""}`}>
          {captain ? <CaptainNav user={user} onNavigate={go} beforeLogout={canLeave} onLogout={() => setState({ kind: "login" })} /> : <NavBar user={user} page={page} onNavigate={go} beforeLogout={canLeave} onLogout={() => setState({ kind: "login" })} />}
          <div className="app-body">
          <DemoBanner demo={demo} />
          <LicenseGate key={user.id} user={user}>
          <ConnectionStatus key={user.id} userId={user.id} captain={captain} />
          <QrNotifications key={user.id} enabled={user.role !== "kitchen"} onReview={() => go({ name: "tables", qrInbox: Date.now() })}>
          <main className="workspace" id="main-content">
          {page.name === "home" && <Home user={user} onNavigate={go} />}
          {page.name === "tables" && <Tables user={user} captain={captain} qrInbox={page.qrInbox} onOpenOrder={onOpenOrder} onTakeaway={() => go({ name: "takeaway" })} />}
          {page.name === "takeaway" && canQuickBill && <QuickTakeaway key={user.id} user={user} onBack={onBack} onOpenOrder={onOpenOrder} />}
          {page.name === "order" && <OrderScreen key={page.orderId} user={user} captain={captain} orderId={page.orderId} onBack={onBack} onOpenOrder={onOpenOrder} quickBilling={canQuickBill} onHold={() => { releaseHeldTakeaway(user.id, page.orderId); onBack(); }} onNextTakeaway={() => go({ name: "takeaway" })} />}
          {page.name === "kitchen" && <KitchenRoute user={user} onNavigate={go} />}
          {page.name === "catalog" && <Catalog />}
          {page.name === "users" && <Users />}
          {page.name === "settings" && <Settings key={page.section ?? ""} section={page.section} />}
          {page.name === "bills" && <Bills onOpenOrder={onOpenOrder} />}
          {page.name === "reports" && <SalesReports initialTab={page.tab} initialPeriod={page.period} canSeeCosts={user.role === "admin"} canSeeZomato={canReconcileZomato(user.role)} onOpenOrder={onOpenOrder} />}
          {page.name === "inventory" && <Inventory user={user} />}
          {page.name === "marketplace" && (user.role === "admin" || user.role === "cashier") && <Marketplace user={user} onNavigate={go} />}
          </main>
          </QrNotifications>
          </LicenseGate>
          </div>
        </div></IntegrationsProvider></NavigationGuardContext.Provider>
      );
    }
  }
}
