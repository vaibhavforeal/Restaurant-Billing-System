import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { IntegrationOff, Marketplace, ModuleOff } from "./screens/Marketplace";
import { IntegrationsProvider, useIntegrations } from "./integrations";
import { ModulesProvider, useModules } from "./modules";
import type { ModuleId } from "@masalapos/domain/modules";
import { ConnectionStatus } from "./ConnectionStatus";
import { LicenseGate } from "./screens/LicenseSettings";
import { NavigationGuardContext, type NavigationGuard } from "./navigation-guard";
import { GuestMenu } from "./screens/GuestMenu";
import { FeedbackPage } from "./screens/FeedbackPage";
import { QuickTakeaway, releaseHeldTakeaway } from "./screens/QuickTakeaway";
import { Customers } from "./screens/Customers";
import { QrNotifications } from "./QrNotifications";
import { usePosShortcuts } from "./pos-shortcuts";
import { CaptainNav } from "./CaptainNav";
import { CaptainReconnect } from "./CaptainInstall";
import { captainAndroid, isCaptainPath } from "./captain-pwa";
import { listenForAndroidBack } from "./android-back";
import { StartupScreen } from "./StartupScreen";
import { KitchenApp } from "./KitchenApp";
import { DemoBanner } from "./DemoBanner";
import "./compact-workspace.css";
import { CurrentUserProvider, userCan } from "./permissions";
import { connectWs } from "./ws";
import { isUnreachable, readSignedIn, saveSignedIn } from "./offline-cache";

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
  const feedback = /^\/feedback\/([A-Za-z0-9_-]{32})\/?$/.exec(window.location.pathname);
  if (feedback) return <FeedbackPage token={feedback[1]!} />;
  if (/^\/kitchen\/?$/.test(window.location.pathname)) return <KitchenApp />;
  return <StaffApp />;
}

/** Admins and cashiers reach the kitchen board only while the Kitchen Display is on. Kitchen staff cannot read the Marketplace, so their board explains a turned-off KDS itself. */
function KitchenRoute({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { ready, isEnabled } = useIntegrations();
  if (user.role === "kitchen") return <Kitchen />;
  if (!ready) return <p role="status">Loading kitchen display…</p>;
  if (!isEnabled("kds")) return <IntegrationOff name="Kitchen Display" canManage={userCan(user, "integrations.configure")} onOpenMarketplace={() => onNavigate({ name: "marketplace" })} />;
  return <Kitchen />;
}

/** The Customers area belongs to the CRM & Loyalty add-on: while it is off the page points to the Marketplace. */
function CustomersRoute({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { ready, isEnabled } = useIntegrations();
  if (!ready) return <p role="status">Loading customers…</p>;
  if (!isEnabled("crm")) return <IntegrationOff name="CRM & Loyalty" canManage={userCan(user, "integrations.configure")} onOpenMarketplace={() => onNavigate({ name: "marketplace" })} />;
  return <Customers isAdmin={userCan(user, "settings.manage")} canExport={userCan(user, "crm.export")} />;
}

/** A page that belongs to a module: while the module is not available it explains why instead. */
function ModuleRoute({ id, user, onNavigate, children }: { id: ModuleId; user: User; onNavigate: (page: Page) => void; children: ReactNode }) {
  const { ready, modules } = useModules();
  const state = modules.find((m) => m.id === id);
  if (!ready) return <p role="status">Loading…</p>;
  if (!state?.active) return <ModuleOff module={state ?? null} canManage={userCan(user, "integrations.configure")} onOpenMarketplace={() => onNavigate({ name: "marketplace" })} />;
  return <>{children}</>;
}

function StaffApp() {
  usePosShortcuts();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [demo, setDemo] = useState(false);
  const navigationGuard = useRef(new Set<NavigationGuard>());
  const captainEntry = isCaptainPath();
  const androidBack = useRef<() => boolean>(() => false);
  useEffect(() => { if (captainAndroid()) listenForAndroidBack(() => androidBack.current()); }, []);
  function enter(user: User, offline = false) {
    if (user.role === "waiter" && !captainEntry) { window.location.replace("/captain/"); return; }
    if (!offline && session.token) saveSignedIn(session.token, user);
    // Offline, open where work can continue from this device's copies.
    const page: Page = user.role === "kitchen" ? { name: "kitchen" } : captainEntry || user.role === "waiter" || offline ? { name: "tables" } : { name: "home" };
    setState({ kind: "in", user, page });
  }
  // When an admin changes this person's role or permissions, refresh what they may do without signing them out.
  const signedInId = state.kind === "in" ? state.user.id : null;
  useEffect(() => {
    if (!signedInId) return;
    return connectWs({
      onEvent: (event, data) => {
        if (event !== "user.changed" || (data as { userId?: string } | null)?.userId !== signedInId) return;
        void apiFetch<{ user: User }>("/api/me").then(({ user }) => setState((current) => current.kind === "in" && current.user.id === user.id ? { ...current, user } : current)).catch(() => undefined);
      },
      onStatus: () => {},
      onAuthFail: () => session.clear(),
    });
  }, [signedInId]);
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
            const known = isUnreachable(error) ? readSignedIn(session.token) : null;
            if (known) return enter(known, true);
            if (captainEntry && !(error instanceof ApiError && error.status === 401)) return setState({ kind: "offline" });
            /* token expired — fall through to login */
          }
        }
        setState({ kind: "login" });
      } catch (error) {
        // The hub cannot be reached: the same person on the same session keeps working from this device's copies.
        const known = isUnreachable(error) ? readSignedIn(session.token) : null;
        if (known) return enter(known, true);
        setState({ kind: captainEntry ? "offline" : "login" });
      }
    })();

    return () => {
      session.onUnauthorized = null;
    };
  }, []);

  androidBack.current = () => false;
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
      const canQuickBill = !captain && userCan(user, "bills.settle");
      const canLeave = () => Array.from(navigationGuard.current).every(guard => guard());
      const go = (next: Page) => { if ((next.name !== "takeaway" || canQuickBill) && canLeave()) setState({ kind: "in", user, page: next }); };
      const onOpenOrder = (orderId: string) => setState({ kind: "in", user, page: { name: "order", orderId } });
      const onBack = () => setState({ kind: "in", user, page: { name: "tables" } });
      androidBack.current = () => { if (page.name === "tables") return false; if (canLeave()) onBack(); return true; };
      return (
        <CurrentUserProvider user={user}><NavigationGuardContext.Provider value={navigationGuard}><IntegrationsProvider key={user.id} user={user}><ModulesProvider key={user.id}><div className={`app-shell${captain ? " captain-shell" : ""}${page.name === "tables" || page.name === "order" || page.name === "takeaway" ? " compact-workspace" : ""}${page.name === "tables" ? " tables-workspace" : page.name === "order" || page.name === "takeaway" ? " order-workspace" : ""}`}>
          {captain ? <CaptainNav user={user} onNavigate={go} beforeLogout={canLeave} onLogout={() => setState({ kind: "login" })} /> : <NavBar user={user} page={page} onNavigate={go} beforeLogout={canLeave} onLogout={() => setState({ kind: "login" })} />}
          <div className="app-body">
          <DemoBanner demo={demo} />
          <LicenseGate key={user.id} user={user}>
          <ConnectionStatus key={user.id} userId={user.id} captain={captain} onOpenOrder={(orderId) => { if (canLeave()) onOpenOrder(orderId); }} />
          <QrNotifications key={user.id} enabled={user.role !== "kitchen"} onReview={() => go({ name: "tables", qrInbox: Date.now() })}>
          <main className="workspace" id="main-content">
          {page.name === "home" && <Home user={user} onNavigate={go} />}
          {page.name === "tables" && <Tables user={user} captain={captain} qrInbox={page.qrInbox} onOpenOrder={onOpenOrder} onTakeaway={() => go({ name: "takeaway" })} />}
          {page.name === "takeaway" && canQuickBill && <ModuleRoute id="takeaway" user={user} onNavigate={go}><QuickTakeaway key={user.id} user={user} onBack={onBack} onOpenOrder={onOpenOrder} /></ModuleRoute>}
          {page.name === "order" && <OrderScreen key={page.orderId} user={user} captain={captain} orderId={page.orderId} onBack={onBack} onOpenOrder={onOpenOrder} quickBilling={canQuickBill} onHold={() => { releaseHeldTakeaway(user.id, page.orderId); onBack(); }} onNextTakeaway={() => go({ name: "takeaway" })} />}
          {page.name === "kitchen" && <KitchenRoute user={user} onNavigate={go} />}
          {page.name === "catalog" && userCan(user, "catalog.manage") && <Catalog />}
          {page.name === "users" && userCan(user, "users.manage") && <Users />}
          {page.name === "settings" && userCan(user, "settings.manage") && <Settings key={page.section ?? ""} section={page.section} />}
          {page.name === "bills" && <Bills onOpenOrder={onOpenOrder} />}
          {page.name === "reports" && <SalesReports initialTab={page.tab} initialPeriod={page.period} canSeeCosts={userCan(user, "costs.read")} canSeeZomato={userCan(user, "zomato.read")} canSettle={userCan(user, "bills.settle")} onOpenOrder={onOpenOrder} />}
          {page.name === "inventory" && <ModuleRoute id="inventory" user={user} onNavigate={go}><Inventory user={user} /></ModuleRoute>}
          {page.name === "customers" && userCan(user, "customers.read") && <CustomersRoute user={user} onNavigate={go} />}
          {page.name === "marketplace" && userCan(user, "integrations.read") && <Marketplace user={user} onNavigate={go} />}
          </main>
          </QrNotifications>
          </LicenseGate>
          </div>
        </div></ModulesProvider></IntegrationsProvider></NavigationGuardContext.Provider></CurrentUserProvider>
      );
    }
  }
}
