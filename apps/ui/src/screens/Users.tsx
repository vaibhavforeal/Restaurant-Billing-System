import { Icon, type IconName } from "../Icon";
import "./users.css";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api";
import type { AdminUser } from "../types";
import { usePermissions } from "../permissions";
import { STAFF_RESOURCES, effectiveStaffPermissions, type StaffOverrides } from '@forkflow/domain/staff-permissions';

const ROLES: AdminUser["role"][] = ["admin", "cashier", "waiter", "kitchen"];
const roleIcons: Record<AdminUser['role'], IconName> = {admin:'badge',cashier:'bills',waiter:'users',kitchen:'kitchen'};
function RolePicker({label,value,onChange,disabled=false}:{label:string;value:AdminUser['role'];onChange:(role:AdminUser['role'])=>void;disabled?:boolean}) {
  return <div className="users-role-picker" role="radiogroup" aria-label={label}>{ROLES.map(role => <label key={role} className={`role-choice role-${role}${value===role?' selected':''}`}>
    <input type="radio" aria-label={role === 'waiter' ? 'Captain / waiter' : role} checked={value===role} disabled={disabled} onChange={()=>onChange(role)} />
    <Icon name={roleIcons[role]} size={17} /><span>{role==='waiter'?'Captain / waiter':role==='admin'?'Admin':role==='cashier'?'Cashier':'Kitchen'}</span>
  </label>)}</div>;
}

export function Users() {
  const { allows } = usePermissions();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [role, setRole] = useState<AdminUser["role"]>("waiter");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [overrides, setOverrides] = useState<StaffOverrides>({});
  async function editPermissions(user: AdminUser) {
    setError('');
    try {
      const result = await apiFetch<{overrides:StaffOverrides}>(`/api/users/${user.id}/permissions`);
      setOverrides(result.overrides); setEditing(user);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed to load permissions'); }
  }

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
    if (!allows("users.create")) return;
    void run(async () => {
      await apiFetch("/api/users", { method: "POST", body: JSON.stringify({ name: name.trim(), pin, role }) });
      setName("");
      setPin("");
    });
  }

  function patchUser(id: string, patch: Partial<Pick<AdminUser, "role" | "isActive">> & { pin?: string }) {
    if (!allows(patch.isActive === false ? "users.delete" : "users.update")) return;
    void run(() => apiFetch(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  }

  function setUserPin(u: AdminUser) {
    const next = window.prompt(`New PIN for ${u.name} (4-6 digits)`);
    if (next) patchUser(u.id, { pin: next });
  }

  return (
    <div className="legacy-screen users-screen">
      <h2><span className="users-heading-icon"><Icon name="users" /></span>Users & roles</h2>
      <p>Create staff accounts, choose their roles, and manage access to restaurant functions.</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <legend className="sr-only">Staff accounts</legend>
      <div className="users-create">
        <input aria-label="Staff name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 130 }} />
        <input aria-label="Staff PIN" type="password" placeholder="PIN (4-6 digits)" value={pin} inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value)} style={{ width: 130 }} />
        <RolePicker label="Staff role" value={role} onChange={setRole} />
        <button onClick={addUser} disabled={!allows("users.create") || !name.trim() || !/^\d{4,6}$/.test(pin)}>{role === "waiter" ? "Add captain" : "Add user"}</button>
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
              <td><span className={`user-avatar role-${u.role}`}><Icon name={roleIcons[u.role]} size={17} /></span><strong>{u.name}</strong></td>
              <td>
                <RolePicker disabled={!allows("users.update")} label={`Role for ${u.name}`} value={u.role} onChange={next => patchUser(u.id, { role: next })} />
              </td>
              <td><span className={`user-status ${u.isActive ? "active" : "inactive"}`}><span />{u.isActive ? "Active" : "Inactive"}</span></td>
              <td><div className="user-actions">
                <button disabled={!allows("users.update")} onClick={() => setUserPin(u)}><Icon name="keyboard" size={16} />Set PIN</button>
                <button disabled={u.role === 'admin' || !allows('users.update')} onClick={() => void editPermissions(u)}><Icon name="settings" size={16} />Permissions</button>
                <button className={u.isActive ? "user-danger" : "user-restore"} disabled={!allows(u.isActive ? "users.delete" : "users.update")} onClick={() => patchUser(u.id, { isActive: !u.isActive })}>
                  <Icon name={u.isActive ? "logout" : "refresh"} size={16} />{u.isActive ? "Delete access" : "Restore access"}
                </button></div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </fieldset>
      {editing && <section className="panel" style={{marginTop:16}}>
        <h3>Permissions for {editing.name}</h3>
        <p>Checked permissions are allowed. Clear a checkbox to deny access. Role defaults restores the standard permissions.</p>
        <fieldset disabled={busy} style={{border:0,padding:0}}>
          <table style={{width:'100%'}}><thead><tr><th>Function</th><th>View</th><th>Create</th><th>Modify</th><th>Delete / reverse</th></tr></thead>
          <tbody>{STAFF_RESOURCES.map(resource => <tr key={resource.id}><th scope="row" style={{textAlign:'left'}}>{resource.name}</th>{(['read','create','update','delete'] as const).map(action => {
            const key = `${resource.id}.${action}`;
            return <td key={action}>{(resource.actions as readonly string[]).includes(action) ? <input type="checkbox" aria-label={`${resource.name}: ${action}`} checked={effectiveStaffPermissions(editing.role,overrides)[key] === true} onChange={event => setOverrides(old => ({...old,[key]:event.target.checked}))} /> : '—'}</td>;
          })}</tr>)}</tbody></table>
          <div style={{display:'flex',gap:8,marginTop:16}}>
            <button onClick={() => void run(async () => {await apiFetch(`/api/users/${editing.id}/permissions`,{method:'PUT',body:JSON.stringify({overrides})});setEditing(null);})}>Save permissions</button>
            <button onClick={() => setOverrides({})}>Role defaults</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </fieldset>
      </section>}
    </div>
  );
}
