import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, message } from "./api";

export function useResource<T>(path: string, refresh = 0) {
  const [state, setState] = useState<{ path: string; data: T | null; error: string; loading: boolean }>({ path, data: null, error: "", loading: true });
  useEffect(() => {
    let active = true;
    setState({ path, data: null, error: "", loading: true });
    void api.request<T>(path).then(data => { if (active) setState({ path, data, error: "", loading: false }); }).catch(error => { if (active) setState({ path, data: null, error: message(error), loading: false }); });
    return () => { active = false; };
  }, [path, refresh]);
  return state.path === path ? state : { path, data: null, error: "", loading: true };
}
export function Notice({ error, children }: { error?: string; children?: ReactNode }) { return error ? <div className="notice error" role="alert">{error}</div> : children ? <div className="notice" role="status">{children}</div> : null; }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
export function Loading({ loading, error }: { loading: boolean; error: string }) { return <>{loading && <p className="muted" role="status">Loading cloud data…</p>}<Notice error={error} /></>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Title({ title, description, children }: { title: string; description?: string; children?: ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{children}</div>; }
