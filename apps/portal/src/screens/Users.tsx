import { useState, type FormEvent } from "react";
import type { StaffRecord, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { ROLE_NAMES, ROLES, type Role } from "../../../licensing-worker/src/portal/shared";
import { api, patch, post } from "../api";
import { dateTime, plural } from "../format";
import { Dialog, EmptyRow, Field, LoadError, PageHead, Person, Pill, useData, useRun } from "../ui";

const ROLE_JOBS: Record<Role, string> = {
  admin: "Everything, including staff, settings, licences and credit approvals.",
  sales: "Their own leads, follow-ups, customers and orders, and payment links.",
  accounts: "Payments and GST invoices, and every order.",
  support: "Every customer and counter, support tickets, and resetting a counter's pairing.",
};

export function Users({ me }: { me: StaffUser }) {
  const { data, error, reload } = useData(() => api<{ users: StaffRecord[] }>("/users"), "users");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StaffRecord | null>(null);
  const users = data?.users ?? [];
  const active = users.filter((u) => u.active).length;
  return <>
    <PageHead title="Staff" sub={data ? `${plural(active, "active account")}${users.length > active ? `, ${users.length - active} deactivated` : ""}` : "Loading staff…"}
      actions={<button className="primary" onClick={() => setAdding(true)}>Add staff</button>} />
    {error && <LoadError message={error} retry={reload} />}
    <div className="grid-main"><div className="table-wrap"><table className="data stack-phone">
      <thead><tr><th>Name</th><th>Role</th><th className="phone-hide">Email</th><th>Status</th><th className="num">Last sign-in</th></tr></thead>
      <tbody>
        {users.map((u) => <tr key={u.id} className="clickable" onClick={() => setEditing(u)}>
          <td><Person name={u.name} id={u.id} />{u.id === me.id && <span className="muted"> (you)</span>}</td>
          <td>{ROLE_NAMES[u.role]}</td>
          <td className="phone-hide muted">{u.email}</td>
          <td>{!u.active ? <Pill>Deactivated</Pill> : u.locked ? <Pill tone="warning">Locked for now</Pill> : u.mustChangePassword ? <Pill tone="warning">Temporary password</Pill> : <span className="muted">Active</span>}</td>
          <td className="num muted">{u.lastLoginAt ? dateTime(u.lastLoginAt) : "Never"}</td>
        </tr>)}
        {data && users.length === 0 && <EmptyRow columns={5}>No staff yet.</EmptyRow>}
      </tbody>
    </table></div>
    <aside className="rail"><h2>What each role can do</h2><dl>{ROLES.map((r) => <div key={r}><dt>{ROLE_NAMES[r]}</dt><dd>{ROLE_JOBS[r]}</dd></div>)}</dl></aside></div>
    {adding && <AddStaff onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void reload(); }} />}
    {editing && <EditStaff user={editing} me={me} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
  </>;
}

function RoleSelect({ value, onChange, disabled }: { value: Role; onChange: (role: Role) => void; disabled?: boolean }) {
  return <Field label="Role" hint={ROLE_JOBS[value]}>
    <select value={value} onChange={(e) => onChange(e.target.value as Role)} disabled={disabled}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}</select>
  </Field>;
}

function AddStaff({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", role: "sales" as Role, password: "" });
  const { busy, run, status } = useRun();
  const submit = (e: FormEvent) => { e.preventDefault(); void run(async () => { await post("/users", form); onSaved(); }); };
  return <Dialog title="Add staff" onClose={onClose}>
    <form onSubmit={submit} className="form-grid">
      <Field label="Name"><input required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={busy} /></Field>
      <Field label="Email"><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={busy} /></Field>
      <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} disabled={busy} />
      <Field label="Temporary password" hint="Give it to them in person or by phone. They choose their own at first sign-in.">
        <input type="text" required minLength={10} autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} disabled={busy} /></Field>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Add staff</button></div>
    </form>
  </Dialog>;
}

function EditStaff({ user, me, onClose, onSaved }: { user: StaffRecord; me: StaffUser; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState("");
  const { busy, run, status } = useRun();
  const save = (change: Record<string, unknown>) => run(async () => { await patch(`/users/${user.id}`, change); onSaved(); });
  return <Dialog title={user.name} onClose={onClose}>
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save({ name, role }); }}>
      <Field label="Name"><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></Field>
      <Field label="Email"><input value={user.email} disabled readOnly /></Field>
      <RoleSelect value={role} onChange={setRole} disabled={busy} />
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button className="primary" disabled={busy || (name === user.name && role === user.role)}>Save</button></div>
    </form>
    {user.id !== me.id && <>
      <form className="settings-section" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/users/${user.id}/password`, { password }); onSaved(); }); }}>
        <div><h2>Reset password</h2><p>Their sign-ins end now. They choose a new password when they next sign in.</p></div>
        <div className="stack"><Field label="Temporary password"><input type="text" required minLength={10} autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></Field>
          <div><button className="secondary" disabled={busy || password.length < 10}>Reset password</button></div></div>
      </form>
      <div className="settings-section">
        <div><h2>{user.active ? "Deactivate" : "Reactivate"}</h2><p>{user.active ? `${user.name} is signed out at once and can't sign in. Their customers and history stay.` : `${user.name} can sign in again with their current password.`}</p></div>
        <div><button className={user.active ? "danger" : "secondary"} disabled={busy} onClick={() => {
          if (!user.active || window.confirm(`Deactivate ${user.name}?`)) void save({ active: !user.active });
        }}>{user.active ? `Deactivate ${user.name}` : `Reactivate ${user.name}`}</button></div>
      </div>
    </>}
  </Dialog>;
}
