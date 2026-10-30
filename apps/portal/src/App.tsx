import { useEffect, useState, type ReactNode } from "react";
import type { StaffUser } from "../../licensing-worker/src/portal/api-types";
import { ROLE_NAMES, roleCan, type Permission } from "../../licensing-worker/src/portal/shared";
import { api, ApiError, post, session } from "./api";
import { Icon, Mark, type IconName } from "./icons";
import { Link, match, navigate, useLocation } from "./router";
import { Search } from "./Search";
import { Activity } from "./screens/Activity";
import { Customer } from "./screens/Customer";
import { Customers } from "./screens/Customers";
import { Invoices } from "./screens/Money";
import { Order } from "./screens/Order";
import { OrderEditor } from "./screens/OrderEditor";
import { Orders } from "./screens/Orders";
import { Settings } from "./screens/Settings";
import { ChangePassword, SignIn } from "./screens/SignIn";
import { Users } from "./screens/Users";
import { PageHead } from "./ui";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "out" } | { kind: "in"; user: StaffUser };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    session.onSignedOut = () => setState({ kind: "out" });
    session.onPasswordChange = () => setState((s) => s.kind === "in" ? { kind: "in", user: { ...s.user, mustChangePassword: true } } : s);
    api<{ user: StaffUser }>("/me").then(({ user }) => setState({ kind: "in", user }))
      .catch((e: unknown) => setState(e instanceof ApiError && e.status === 401 ? { kind: "out" } : { kind: "error", message: e instanceof Error ? e.message : "The portal could not start." }));
    return () => { session.onSignedOut = null; session.onPasswordChange = null; };
  }, []);
  switch (state.kind) {
    case "loading": return <main className="signin" aria-busy="true"><p className="muted">Opening ForkFlow Portal…</p></main>;
    case "error": return <main className="signin"><div className="signin-card"><h1>The portal could not start</h1><p className="muted">{state.message}</p>
      <button className="primary" onClick={() => window.location.reload()}>Try again</button></div></main>;
    case "out": return <SignIn onSignedIn={(user) => setState({ kind: "in", user })} />;
    case "in": return state.user.mustChangePassword
      ? <ChangePassword forced onDone={(user) => setState({ kind: "in", user })} />
      : <Shell user={state.user} onSignedOut={() => setState({ kind: "out" })} onUser={(user) => setState({ kind: "in", user })} />;
  }
}

interface NavItem { to: string; label: string; icon: IconName; permission?: Permission }
const WORK: NavItem[] = [
  { to: "/customers", label: "Customers", icon: "customers", permission: "customers.read" },
  { to: "/orders", label: "Orders", icon: "orders", permission: "orders.read" },
  { to: "/invoices", label: "Invoices", icon: "invoices", permission: "orders.read" },
];
const ADMIN: NavItem[] = [
  { to: "/admin/users", label: "Staff", icon: "users", permission: "users.manage" },
  { to: "/admin/settings", label: "Settings", icon: "settings", permission: "settings.manage" },
  { to: "/admin/activity", label: "Activity", icon: "activity", permission: "activity.read" },
];

function Shell({ user, onSignedOut, onUser }: { user: StaffUser; onSignedOut: () => void; onUser: (user: StaffUser) => void }) {
  const { path, search } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [path]);
  const allowed = (items: NavItem[]) => items.filter((item) => !item.permission || roleCan(user.role, item.permission));
  const work = allowed(WORK), admin = allowed(ADMIN);
  const first = work[0]?.to ?? admin[0]?.to ?? "/account";
  useEffect(() => { if (path === "/" || path === "") navigate(first, true); }, [path, first]);
  const current = (to: string) => path === to || path.startsWith(`${to}/`);
  const nav = (item: NavItem) => <Link key={item.to} to={item.to} className="nav-item" aria-current={current(item.to) ? "page" : undefined}><Icon name={item.icon} />{item.label}</Link>;
  return <div className={`app${menuOpen ? " menu-open" : ""}`}>
    <aside className="sidebar" aria-label="Portal navigation">
      <div className="brand"><Mark /><div>ForkFlow Portal<small>Sales, licences and support</small></div></div>
      {work.length > 0 && <nav className="nav-group">{work.map(nav)}</nav>}
      {admin.length > 0 && <nav className="nav-group" aria-label="Administration"><div className="nav-heading">Administration</div>{admin.map(nav)}</nav>}
      <div className="account">
        <div className="who"><span className="initial" aria-hidden="true" style={{ background: "#f3dfe2", color: "#7a1424" }}>{user.name[0]?.toUpperCase()}</span>
          <div><strong>{user.name}</strong><span>{ROLE_NAMES[user.role]}</span></div></div>
        <Link to="/account" className="nav-item" aria-current={current("/account") ? "page" : undefined}><Icon name="key" />Password</Link>
        <button type="button" className="nav-item" style={{ border: 0, background: "none", cursor: "pointer", width: "100%", textAlign: "left" }}
          onClick={() => { void post("/logout").finally(onSignedOut); }}><Icon name="logout" />Sign out</button>
      </div>
    </aside>
    <div className="topbar"><button type="button" className="ghost menu-button" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
      <span style={{ width: 16, height: 16, display: "inline-block" }}><Icon name="menu" /></span></button><Search /></div>
    <main className="sheet" id="main">{route(path, search, user, onUser)}</main>
  </div>;
}

function route(path: string, search: URLSearchParams, user: StaffUser, onUser: (user: StaffUser) => void): ReactNode {
  const can = (p: Permission) => roleCan(user.role, p);
  let m: Record<string, string> | null;
  if (match("/customers", path) && can("customers.read")) return <Customers me={user} />;
  if ((m = match("/customers/:id", path)) && can("customers.read")) return <Customer key={m["id"]} id={m["id"]!} me={user} />;
  if (match("/orders", path) && can("orders.read")) return <Orders me={user} />;
  if (match("/invoices", path) && can("orders.read")) return <Invoices />;
  if (match("/orders/new", path) && can("orders.write")) {
    const kind = search.get("kind");
    return <OrderEditor key={search.toString()} customerId={search.get("customerId")} {...(kind === "trial" || kind === "renewal" ? { kind } : {})} />;
  }
  if ((m = match("/orders/:id/edit", path)) && can("orders.write")) return <OrderEditor key={m["id"]} customerId={null} orderId={m["id"]!} />;
  if ((m = match("/orders/:id", path)) && can("orders.read")) return <Order key={m["id"]} id={m["id"]!} me={user} />;
  if (match("/admin/users", path) && can("users.manage")) return <Users me={user} />;
  if (match("/admin/settings", path) && can("settings.manage")) return <Settings />;
  if (match("/admin/activity", path) && can("activity.read")) return <Activity />;
  if (match("/account", path)) return <><PageHead title="Your password" sub={`Signed in as ${user.email}.`} /><ChangePassword onDone={onUser} /></>;
  if (path === "/" || path === "") return null;
  return <PageHead title="Not found" sub="This page doesn't exist, or your role can't open it." />;
}
