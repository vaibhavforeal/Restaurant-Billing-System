import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import type { AdminUser } from "../types";

const ROLES: AdminUser["role"][] = ["admin", "cashier", "waiter", "kitchen"];

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [role, setRole] = useState<AdminUser["role"]>("waiter");
  const [error, setError] = useState("");

  async function reload() {
    const { users } = await apiFetch<{ users: AdminUser[] }>("/api/users");
    setUsers(users);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load users"));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    }
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
    <div style={{ maxWidth: 640, margin: "4vh auto", fontFamily: "system-ui" }}>
      <h2>Users</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
        <input placeholder="PIN (4-6 digits)" value={pin} inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value)} style={{ width: 130 }} />
        <select value={role} onChange={(e) => setRole(e.target.value as AdminUser["role"])}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button onClick={addUser} disabled={!name.trim() || !/^\d{4,6}$/.test(pin)}>Add</button>
      </div>
      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>
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
                <select value={u.role} onChange={(e) => patchUser(u.id, { role: e.target.value as AdminUser["role"] })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
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
  );
}
