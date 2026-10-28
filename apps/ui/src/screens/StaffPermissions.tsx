import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import type { AdminUser } from "../types";

interface PermissionArea { id: string; name: string; actions: Array<{ slug: string; label: string }> }
interface PersonPermissions {
  role: AdminUser["role"];
  areas: PermissionArea[];
  adminOnly: string[];
  /** What the role gives, per permission, before any change for this person. */
  defaults: Record<string, boolean>;
  overrides: Record<string, boolean>;
  effective: string[];
}

/** The changes from the role that `draft` represents: only permissions that differ from the role's default. */
export function overridesFor(defaults: Record<string, boolean>, draft: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(draft).filter(([slug, on]) => defaults[slug] !== on));
}

/** One person's permissions, grouped by area: tick to allow, untick to remove, starting from their role. */
export function StaffPermissions({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<PersonPermissions | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const accept = (p: PersonPermissions) => {
    setData(p);
    setDraft(Object.fromEntries(Object.keys(p.defaults).map((slug) => [slug, p.effective.includes(slug)])));
  };
  useEffect(() => {
    apiFetch<{ permissions: PersonPermissions }>(`/api/users/${user.id}/permissions`)
      .then((r) => accept(r.permissions)).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load permissions"));
  }, [user.id]);

  async function save(overrides: Record<string, boolean>) {
    setBusy(true); setError("");
    try {
      const r = await apiFetch<{ permissions: PersonPermissions }>(`/api/users/${user.id}/permissions`, { method: "PUT", body: JSON.stringify({ overrides }) });
      accept(r.permissions); onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save permissions"); }
    finally { setBusy(false); }
  }

  const changes = data ? overridesFor(data.defaults, draft) : {};
  const changeCount = Object.keys(changes).length;
  return <section className="panel staff-permissions" aria-label={`Permissions for ${user.name}`}>
    <div className="staff-permissions-head">
      <div><h3>Permissions for {user.name}</h3><p className="muted">Starts from the {user.role === "waiter" ? "captain / waiter" : user.role} role. Tick to allow, untick to take away.</p></div>
      <button type="button" onClick={onClose}>Close</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!data ? !error && <p role="status">Loading…</p> : <>
      <fieldset disabled={busy} className="staff-permissions-grid">
        {data.areas.map((area) => <div key={area.id} className="staff-permissions-area">
          <h4>{area.name}</h4>
          {area.actions.map((action) => {
            const on = draft[action.slug] ?? false;
            const role = data.defaults[action.slug] ?? false;
            return <label key={action.slug} className="staff-permission">
              <input type="checkbox" checked={on} onChange={(e) => setDraft({ ...draft, [action.slug]: e.target.checked })} />
              <span>{action.label}</span>
              {on !== role && <small className={on ? "staff-permission-added" : "staff-permission-removed"}>{on ? "Added" : "Removed"}</small>}
            </label>;
          })}
        </div>)}
        <div className="staff-permissions-area">
          <h4>Staff and settings</h4>
          <p className="muted">Admin only. Make this person an admin to let them manage staff or settings.</p>
        </div>
      </fieldset>
      <div className="staff-permissions-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save(changes)}>Save</button>
        <button type="button" disabled={busy || changeCount === 0} onClick={() => void save({})}>Reset to role defaults</button>
        <span className="muted">{changeCount === 0 ? "Same as the role." : `${changeCount} change${changeCount === 1 ? "" : "s"} from the role.`}</span>
      </div>
    </>}
  </section>;
}
