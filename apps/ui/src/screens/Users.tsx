import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api";
import type { AdminUser } from "../types";

const ROLES: AdminUser["role"][] = ["admin", "cashier", "waiter", "kitchen"];

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [role, setRole] = useState<AdminUser["role"]>("waiter");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");

  async function reload() {
    const staff = await apiFetch<{ users: AdminUser[] }>("/api/users");
    setUsers(staff.users);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load users"));
  }, []);

  async function run(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    setError("");
    try {
      await action();
      await reload();
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    } finally { lock.current = false; setBusy(false); }
  }

  function addUser() {
    void run(async () => {
      await apiFetch("/api/users", { method: "POST", body: JSON.stringify({ name: name.trim(), pin, role }) });
      setName("");
      setPin("");
    });
  }

  function patchUser(id: string, patch: Partial<Pick<AdminUser, "role" | "isActive">> & { pin?: string }) {
    void run(() => apiFetch(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  }

  function setUserPin(u: AdminUser) {
    const next = window.prompt(`New PIN for ${u.name} (4-6 digits)`);
    if (next) patchUser(u.id, { pin: next });
  }

  return (
    <div className="legacy-screen">
      <h2>Users & captains</h2>
      <p>Create captains here with a unique PIN. Choose the captain on each customer's order when they arrive.</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <legend className="sr-only">Staff accounts</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input aria-label="Staff name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 130 }} />
        <input aria-label="Staff PIN" type="password" placeholder="PIN (4-6 digits)" value={pin} inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value)} style={{ width: 130 }} />
        <select aria-label="Staff role" value={role} onChange={(e) => setRole(e.target.value as AdminUser["role"])}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r === "waiter" ? "Captain / waiter" : r}</option>
          ))}
        </select>
        <button onClick={addUser} disabled={!name.trim() || !/^\d{4,6}$/.test(pin)}>{role === "waiter" ? "Add captain" : "Add user"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th style={{ padding: 6 }}>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid #eee", opacity: u.isActive ? 1 : 0.45 }}>
              <td style={{ padding: 6 }}>{u.name}</td>
              <td>
                <select aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => patchUser(u.id, { role: e.target.value as AdminUser["role"] })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r === "waiter" ? "Captain / waiter" : r}</option>
                  ))}
                </select>
              </td>
              <td>{u.isActive ? "active" : "inactive"}</td>
              <td style={{ display: "flex", gap: 4, padding: 4 }}>
                <button onClick={() => setUserPin(u)}>Set PIN</button>
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
    </div>
  );
}
