import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** One request at a time, with its outcome as an alert or a status line. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const run = useCallback(async (action: () => Promise<unknown>, done = "") => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); if (mounted.current) setMessage(done); return true; }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "That didn't work. Try again."); return false; }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }, []);
  const status = error ? <p className="notice negative" role="alert">{error}</p> : message ? <p className="notice" role="status">{message}</p> : null;
  return { busy, run, status, error, setError, setMessage };
}

/** Data for a screen: reloads when `key` changes, ignores answers that arrive after a newer request. */
export function useData<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try { const value = await load(); if (request === sequence.current) { setData(value); setError(""); } }
    catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : "Couldn't load this."); }
    finally { if (request === sequence.current) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { void reload(); return () => { sequence.current++; }; }, [reload]);
  return { data, error, loading, reload, setData };
}

/** The screen's title row: a noun h1, an optional grey line about the data, and its real actions on the right. */
export function PageHead({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return <header className="page-head">
    <div>{back && <div className="crumb">{back}</div>}<h1>{title}</h1>{sub && <p className="page-sub">{sub}</p>}</div>
    {actions && <div className="actions">{actions}</div>}
  </header>;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void; label: string }) {
  return <div className="tabs" role="tablist" aria-label={label}>
    {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={tab.id === value} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </div>;
}

export type Tone = "neutral" | "positive" | "negative" | "warning" | "accent";
export const Pill = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => <span className={`pill ${tone}`}>{children}</span>;

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <label className={`field${wide ? " wide" : ""}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

/** A person as themselves: a stable initial on a pale tint of their own hue (identity, never data). */
export function Person({ name, id }: { name: string; id?: string }) {
  // FNV-1a over the id, so similar ids still land on different hues.
  let hash = 2166136261;
  for (const char of id ?? name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const hue = (hash >>> 0) % 360;
  return <span className="person"><span className="initial" aria-hidden="true" style={{ background: `hsl(${hue} 60% 92%)`, color: `hsl(${hue} 45% 28%)` }}>{name.trim()[0]?.toUpperCase() ?? "?"}</span>{name}</span>;
}

/** A modal on the native dialog element: Escape and the Close button dismiss it, focus stays inside. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); }, []);
  return createPortal(<dialog ref={ref} className={`dialog${wide ? " wide" : ""}`} aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><button type="button" className="ghost" onClick={onClose}>Close</button></header>
    {children}
  </dialog>, document.body);
}

/** An empty table or list keeps its frame and says so in one sentence across the block. */
export const EmptyRow = ({ columns, children }: { columns: number; children: ReactNode }) => <tr className="empty"><td colSpan={columns}>{children}</td></tr>;

/** A block that failed to load says what failed, inside the block, with Retry. */
export const LoadError = ({ message, retry }: { message: string; retry: () => void }) =>
  <p className="notice negative" role="alert">{message} <button type="button" className="link" onClick={retry}>Retry</button></p>;

/** Copies text, then says so for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="ghost small" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
    {copied ? "Copied" : label}</button>;
}
