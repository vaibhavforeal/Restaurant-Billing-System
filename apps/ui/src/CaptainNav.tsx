import { useState } from "react";
import { apiFetch, session, type User } from "./api";
import { Brand, Icon } from "./Icon";
import type { Page } from "./NavBar";
import { ThemeToggle } from "./ThemeToggle";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { CaptainInstall } from "./CaptainInstall";
import { useShortcutLabels } from "./pos-shortcuts";

export function CaptainNav({ user, onNavigate, onLogout, beforeLogout }: {
  user: User; onNavigate: (page: Page) => void; onLogout: () => void; beforeLogout: () => boolean;
}) {
  const { shortcut, shortcutProps } = useShortcutLabels();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function logout() {
    if (busy || !beforeLogout()) return;
    setBusy(true);
    try { await apiFetch<void>("/api/logout", { method: "POST" }); }
    catch { /* Local sign-out still works when disconnected. */ }
    finally { session.clear(); onLogout(); }
  }
  return <header className="captain-header">
    <button className="captain-brand" {...shortcutProps("tables")} title={shortcut("tables", "Tables")} onClick={() => onNavigate({ name: "tables" })} aria-label="Captain tables"><Brand /><span>Captain</span></button>
    <button className="captain-account" aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name="users" size={16} /><span>{user.name}</span></button>
    <WorkspaceDialog open={open} title="Captain account" onClose={() => setOpen(false)} busy={busy} className="captain-dialog captain-account-dialog">
      <p><strong>{user.name}</strong> · {user.role === "waiter" ? "Captain" : user.role}</p>
      <div className="captain-account-actions">
        <button {...shortcutProps("tables")} title={shortcut("tables", "Tables")} onClick={() => { setOpen(false); onNavigate({ name: "tables" }); }}>Tables & orders</button>
        <button onClick={() => { setOpen(false); onNavigate({ name: "home" }); }}>Service overview</button>
        <ThemeToggle />
        {user.role !== "waiter" && <button onClick={() => { if (beforeLogout()) window.location.assign("/"); }}>Open full POS</button>}
      </div>
      <CaptainInstall />
      <button className="captain-signout" disabled={busy} onClick={() => void logout()}>{busy ? "Signing out…" : "Sign out"}</button>
    </WorkspaceDialog>
  </header>;
}
