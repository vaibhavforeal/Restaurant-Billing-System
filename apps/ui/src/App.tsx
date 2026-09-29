import { useEffect, useState } from "react";
import { apiFetch, session, type User } from "./api";
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
import { DayEnd } from "./screens/DayEnd";
import { Inventory } from "./screens/Inventory";
import { ConnectionStatus } from "./ConnectionStatus";

type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "in"; user: User; page: Page };


export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const pageKey = state.kind === "in" ? state.page.name === "order" ? state.page.orderId : state.page.name : state.kind;
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [pageKey]);

  useEffect(() => {
    // Register expiry handler
    session.onUnauthorized = () => setState({ kind: "login" });

    void (async () => {
      try {
        const { needsSetup } = await apiFetch<{ needsSetup: boolean }>("/api/needs-setup");
        if (needsSetup) return setState({ kind: "setup" });
        if (session.token) {
          try {
            const { user } = await apiFetch<{ user: User }>("/api/me");
            const initialPage: Page = user.role === "kitchen" ? { name: "kitchen" } : { name: "home" };
            return setState({ kind: "in", user, page: initialPage });
          } catch {
            /* token expired — fall through to login */
          }
        }
        setState({ kind: "login" });
      } catch {
        setState({ kind: "login" }); // server down: login screen will show "Server unreachable"
      }
    })();

    return () => {
      session.onUnauthorized = null;
    };
  }, []);

  switch (state.kind) {
    case "loading":
      return <div className="loading-state" role="status">Opening your workspace…</div>;
    case "setup":
      return <Setup onDone={(user) => setState({ kind: "in", user, page: { name: "home" } })} />;
    case "login":
      return <Login onLogin={(user) => setState({ kind: "in", user, page: user.role === "kitchen" ? { name: "kitchen" } : { name: "home" } })} />;
    case "in": {
      const { user, page } = state;
      const go = (next: Page) => setState({ kind: "in", user, page: next });
      const onOpenOrder = (orderId: string) => setState({ kind: "in", user, page: { name: "order", orderId } });
      const onBack = () => setState({ kind: "in", user, page: { name: "tables" } });
      return (
        <div className="app-shell">
          <NavBar user={user} page={page} onNavigate={go} onLogout={() => setState({ kind: "login" })} />
          <div className="app-body">

          <ConnectionStatus key={user.id} userId={user.id} />
          <main className="workspace" id="main-content">
          {page.name === "home" && <Home user={user} onNavigate={go} />}
          {page.name === "tables" && <Tables user={user} onOpenOrder={onOpenOrder} />}
          {page.name === "order" && <OrderScreen key={page.orderId} user={user} orderId={page.orderId} onBack={onBack} onOpenOrder={onOpenOrder} />}
          {page.name === "kitchen" && <Kitchen />}
          {page.name === "catalog" && <Catalog />}
          {page.name === "users" && <Users />}
          {page.name === "settings" && <Settings />}
          {page.name === "bills" && <Bills onOpenOrder={onOpenOrder} />}
          {page.name === "reports" && <DayEnd />}
          {page.name === "inventory" && <Inventory user={user} />}
          </main>
          </div>
        </div>
      );
    }
  }
}
