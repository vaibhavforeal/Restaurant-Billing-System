import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { effectiveStaffPermissions, type StaffOverrides } from "@forkflow/domain/staff-permissions";
import { apiFetch, session, type User } from "./api";
import { connectWs } from "./ws";
const PermissionContext = createContext<StaffOverrides | null>(null);
export function usePermissions(role: User["role"] = "admin") {
  const values = useContext(PermissionContext) ?? effectiveStaffPermissions(role);
  return { allows: (permission: string) => values[permission] === true };
}
export function PermissionsProvider({ user, children }: { user: User; children: ReactNode }) {
  const [permissions, setPermissions] = useState(() => effectiveStaffPermissions(user.role));
  useEffect(() => {
    let active = true, sequence = 0;
    const refresh = async () => { const request = ++sequence; try { const result = await apiFetch<{ permissions: StaffOverrides }>("/api/me/permissions"); if (active && request === sequence) setPermissions(result.permissions); } catch { /* server remains authoritative */ } };
    void refresh();
    const focus = () => void refresh(); window.addEventListener("focus", focus);
    const dispose = connectWs({ onEvent: event => { if (event === "features.changed" || event === "license.changed") void refresh(); }, onStatus: connected => { if (connected) void refresh(); }, onAuthFail: () => session.clear() });
    return () => { active = false; window.removeEventListener("focus", focus); dispose(); };
  }, [user.id, user.role]);
  return <PermissionContext.Provider value={permissions}>{children}</PermissionContext.Provider>;
}
export function PermissionWorkspace({ permission, children }: { permission: string; children: ReactNode }) {
  const { allows } = usePermissions();
  return allows(permission) ? <>{children}</> : <div className="panel" role="status">You do not have permission to access this data. Contact your restaurant administrator to change your staff permissions.</div>;
}
