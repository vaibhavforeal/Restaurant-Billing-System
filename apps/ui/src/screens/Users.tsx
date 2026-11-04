import { useAction } from "../use-action";
import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { AdminUser } from "../types";
import { DiscountCaps } from "./DiscountCaps";
import { StaffPermissions } from "./StaffPermissions";
import "../staff-permissions.css";

const ROLES: AdminUser["role"][] = ["admin", "cashier", "waiter", "kitchen"];

const VALID_PIN = /^\d{4,6}$/;
const VALID_USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;

/** Asks for a new admin's approval PIN; null when cancelled or not 4-6 digits. */
function askApprovalPin(name: string): string | null {
  const pin = window.prompt(`Approval PIN for ${name} (4-6 digits). Admins type it at the counter to approve discounts, voids, refunds and remote support.`)?.trim();
  if (!pin) return null;
  if (!VALID_PIN.test(pin)) { window.alert("The approval PIN must be 4-6 digits."); return null; }
  return pin;
}

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [role, setRole] = useState<AdminUser["role"]>("waiter");
  const { busy, error, setError, run: act } = useAction();
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<AdminUser | null>(null);

  async function reload() {
    const staff = await apiFetch<{ users: AdminUser[] }>("/api/users");
    setUsers(staff.users);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load users"));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setMessage("");
    if (await act(async () => { await action(); await reload(); })) setMessage("Saved.");
  }

  const cleanUsername = username.trim().toLowerCase();
  const canAdd = !!name.trim() && VALID_USERNAME.test(cleanUsername) && password.length >= MIN_PASSWORD && (role !== "admin" || VALID_PIN.test(pin));

  function addUser() {
    void run(async () => {
      await apiFetch("/api/users", { method: "POST", body: JSON.stringify({ name: name.trim(), username: cleanUsername, password, role, ...(role === "admin" ? { pin } : {}) }) });
      setName(""); setUsername(""); setPassword(""); setPin("");
    });
  }

  function patchUser(id: string, patch: Partial<Pick<AdminUser, "role" | "isActive" | "maxDiscountPercent" | "username">> & { pin?: string; password?: string }) {
    void run(() => apiFetch(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  }

  function changeRole(u: AdminUser, next: AdminUser["role"]) {
    const changes = u.permissionChanges ?? 0;
    if (changes && !window.confirm(`Changing ${u.name}'s role clears their ${changes === 1 ? "1 permission change" : `${changes} permission changes`}. They get the new role's permissions. Continue?`)) return;
    if (next === "admin") {
      const approvalPin = askApprovalPin(u.name);
      if (approvalPin) patchUser(u.id, { role: next, pin: approvalPin });
      return;
    }
    patchUser(u.id, { role: next });
  }

  function resetPassword(u: AdminUser) {
    const next = window.prompt(`New password for ${u.name} (at least ${MIN_PASSWORD} characters). They will be signed out on every device.`);
    if (next === null) return;
    if (next.length < MIN_PASSWORD) { setError(`Use at least ${MIN_PASSWORD} characters for the password.`); return; }
    patchUser(u.id, { password: next });
  }

  function changeUsername(u: AdminUser) {
    const next = window.prompt(`New username for ${u.name}`, u.username)?.trim().toLowerCase();
    if (!next || next === u.username) return;
    if (!VALID_USERNAME.test(next)) { setError("Use 3-32 letters, numbers, dots, dashes or underscores for the username, starting with a letter or number."); return; }
    patchUser(u.id, { username: next });
  }

  function setApprovalPin(u: AdminUser) {
    const next = askApprovalPin(u.name);
    if (next) patchUser(u.id, { pin: next });
  }

  return (
    <div className="legacy-screen">
      <h2>Users & captains</h2>
      <p>Everyone signs in with their username and password. Admins also have an approval PIN for approving discounts, voids and refunds at the counter. Choose the captain on each customer's order when they arrive.</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <legend className="sr-only">Staff accounts</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input aria-label="Staff name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 130 }} />
        <input aria-label="Staff username" placeholder="Username" value={username} autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={32} onChange={(e) => setUsername(e.target.value)} style={{ width: 140 }} />
        <input aria-label="Staff password" type="password" placeholder={`Password (${MIN_PASSWORD}+ characters)`} value={password} autoComplete="new-password" maxLength={128} onChange={(e) => setPassword(e.target.value)} style={{ width: 190 }} />
        <select aria-label="Staff role" value={role} onChange={(e) => setRole(e.target.value as AdminUser["role"])}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r === "waiter" ? "Captain / waiter" : r}</option>
          ))}
        </select>
        {role === "admin" && <input aria-label="Approval PIN" type="password" placeholder="Approval PIN (4-6 digits)" value={pin} inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={{ width: 170 }} />}
        <button onClick={addUser} disabled={!canAdd}>{role === "waiter" ? "Add captain" : "Add user"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th style={{ padding: 6 }}>Name</th>
            <th>Username</th>
            <th>Role</th>
            <th>Discount limit</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid #eee", opacity: u.isActive ? 1 : 0.45 }}>
              <td style={{ padding: 6 }}>{u.name}</td>
              <td>{u.username || <em>none</em>}</td>
              <td>
                <select aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => changeRole(u, e.target.value as AdminUser["role"])}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r === "waiter" ? "Captain / waiter" : r}</option>
                  ))}
                </select>
              </td>
              <td>{u.role === "admin" ? "No limit" : <input type="number" min={0} max={100} step="0.5" style={{ width: 70 }} aria-label={`Discount limit (%) for ${u.name}`} placeholder="Role default" defaultValue={u.maxDiscountPercent ?? ""} key={`${u.id}-${u.maxDiscountPercent ?? ""}`}
                onBlur={(e) => { const raw = e.target.value.trim(); const next = raw === "" ? null : Number(raw); if (next !== u.maxDiscountPercent && (next === null || (Number.isFinite(next) && next >= 0 && next <= 100))) patchUser(u.id, { maxDiscountPercent: next }); }} />}</td>
              <td>{u.isActive ? "active" : "inactive"}</td>
              <td style={{ display: "flex", gap: 4, padding: 4 }}>
                <button onClick={() => resetPassword(u)}>Reset password</button>
                <button onClick={() => changeUsername(u)}>Change username</button>
                {u.role === "admin" && <button onClick={() => setApprovalPin(u)}>Set approval PIN</button>}
                {u.role !== "admin" && <button aria-pressed={editing?.id === u.id} onClick={() => setEditing(u)}>Permissions{u.permissionChanges ? ` (${u.permissionChanges} changed)` : ""}</button>}
                <button onClick={() => patchUser(u.id, { isActive: !u.isActive })}>
                  {u.isActive ? "Deactivate" : "Activate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </fieldset>
      {editing && <StaffPermissions key={editing.id} user={editing} onClose={() => setEditing(null)} onSaved={() => { void reload(); setMessage(`Permissions saved for ${editing.name}.`); }} />}
      <DiscountCaps />
    </div>
  );
}
