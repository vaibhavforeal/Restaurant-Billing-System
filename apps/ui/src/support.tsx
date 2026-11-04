// MasalaPOS support in the POS: the Get support button (a chat with MasalaPOS in the browser), the consent prompt for remote access
// on the PC being shared, and Settings → Help & support.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, type User } from "./api";
import { Icon } from "./Icon";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { connectWs } from "./ws";
import "./support.css";

declare global {
  interface Window {
    /** Set by the MasalaPOS desktop app's preload: this window is on the PC itself and can share its screen. */
    masalaposDesktop?: { remoteSupport: boolean };
  }
}
/** Only the desktop app's own window answers remote-access requests: never a browser or tablet elsewhere on the network. */
const onThisPc = () => window.masalaposDesktop?.remoteSupport === true;

export interface PendingRequest { sessionId: string; agentName: string; reason: string; mode: "view" | "control"; expiresAt: number; connectorUrl?: string }
export interface ActiveSession { sessionId: string; agentName: string; mode: "view" | "control"; startedAt: number | null }
export interface SupportStatus { online: boolean; available: boolean; canShare: boolean; remoteEnabled: boolean; pending: PendingRequest | null; active: ActiveSession | null }

/** Opens the support chat in the browser. Outside the desktop app a tab is opened first, while the click still counts, then pointed at the chat. */
function useOpenSupport() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const open = useCallback(async () => {
    if (busy) return;
    setBusy(true); setMessage(null);
    const tab = onThisPc() ? null : window.open("", "_blank");
    try {
      const { url, message: why } = await apiFetch<{ url: string | null; message: string | null }>("/api/support/link", { method: "POST" });
      if (!url) { tab?.close(); setMessage(why ?? "Couldn't open MasalaPOS support."); return; }
      if (tab) { tab.opener = null; tab.location.href = url; } else window.open(url, "_blank", "noopener");
    } catch (error) {
      tab?.close();
      setMessage(error instanceof Error ? error.message : "Couldn't open MasalaPOS support.");
    } finally { setBusy(false); }
  }, [busy]);
  return { open, busy, message, clear: () => setMessage(null) };
}

export function GetSupportButton({ className = "nav-item support-link" }: { className?: string }) {
  const { open, busy, message, clear } = useOpenSupport();
  return <>
    <button className={className} onClick={() => void open()} disabled={busy} title="Chat with MasalaPOS support" aria-label="Get support">
      <Icon name="help" /><span>{busy ? "Opening…" : "Get support"}</span>
    </button>
    <WorkspaceDialog open={message !== null} title="MasalaPOS support" onClose={clear} className="support-dialog">
      <p>{message}</p>
      <div className="support-dialog-actions"><button onClick={clear}>OK</button></div>
    </WorkspaceDialog>
  </>;
}

/** Keeps the support status current: pushed over the POS socket, and checked every few seconds on the PC itself. */
function useSupportStatus(poll: boolean): [SupportStatus | null, (s: SupportStatus) => void] {
  const [status, setStatus] = useState<SupportStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void apiFetch<SupportStatus>("/api/support/status").then((s) => { if (alive) setStatus(s); }).catch(() => {});
    load();
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "support.remote") setStatus((s) => s && { ...s, ...(data as Pick<SupportStatus, "pending" | "active">) });
        else if (event === "support.status") setStatus((s) => s && { ...s, online: (data as { online: boolean }).online });
      },
      onStatus: (connected) => { if (connected) load(); },
    });
    const timer = poll ? setInterval(load, 3_000) : null;
    return () => { alive = false; dispose(); if (timer) clearInterval(timer); };
  }, [poll]);
  return [status, (s) => setStatus(s)];
}

/**
 * On the PC itself: asks whoever is at the counter to allow or refuse a remote-access request, and shows a strip with Stop while a
 * session runs. Allowing needs an admin: the signed-in one, or an admin's PIN typed here.
 */
export function RemoteConsent({ user }: { user: User }) {
  const desktop = onThisPc();
  if (!desktop) return null;
  return <RemoteConsentOnPc user={user} />;
}

function RemoteConsentOnPc({ user }: { user: User }) {
  const [status, setStatus] = useSupportStatus(true);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const pending = status?.pending ?? null, active = status?.active ?? null;
  useEffect(() => { setPin(""); setError(""); }, [pending?.sessionId]);
  useEffect(() => { if (!pending) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [pending]);

  const isAdmin = user.role === "admin";
  const answer = async (decision: "deny" | "view" | "control", e?: FormEvent) => {
    e?.preventDefault();
    if (!pending || busy) return;
    if (decision !== "deny" && !isAdmin && !/^\d{4,12}$/.test(pin)) { setError("Ask an admin to type their PIN to allow this."); return; }
    setBusy(true); setError("");
    try {
      const next = await apiFetch<Pick<SupportStatus, "pending" | "active">>("/api/support/remote/answer", { method: "POST",
        body: JSON.stringify({ sessionId: pending.sessionId, decision, ...(decision !== "deny" && !isAdmin ? { approverPin: pin } : {}) }) });
      if (status) setStatus({ ...status, ...next });
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!active) return;
    try { const next = await apiFetch<Pick<SupportStatus, "pending" | "active">>("/api/support/remote/stop", { method: "POST", body: JSON.stringify({ sessionId: active.sessionId }) });
      if (status) setStatus({ ...status, ...next }); } catch { /* the desktop banner's Stop still works */ }
  };

  const seconds = pending ? Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)) : 0;
  return <>
    {active && <div className="remote-strip" role="status">
      <span className="remote-dot" aria-hidden="true" />
      <span><strong>{active.agentName}</strong> from MasalaPOS support {active.startedAt ? (active.mode === "control" ? "is viewing and can control this PC" : "is viewing this PC") : "is connecting…"}</span>
      <button onClick={() => void stop()}>Stop</button>
    </div>}
    <WorkspaceDialog open={pending !== null} title={pending?.connectorUrl ? "MasalaPOS support sent a connector" : "MasalaPOS support wants to see this PC"} onClose={() => void answer("deny")} busy={busy} className="remote-consent">
      {pending && <form onSubmit={(e) => void answer(pending.mode === "control" ? "control" : "view", e)}>
        <p className="remote-consent-who"><strong>{pending.agentName}</strong> from MasalaPOS support asks to <strong>{pending.mode === "control" ? "see and control" : "see"}</strong> this PC's screen.</p>
        <blockquote className="remote-consent-reason">{pending.reason}</blockquote>
        {pending.connectorUrl && <p>Download and run Support Connector. Windows will ask for administrator permission, then the connector asks you what support may access.</p>}
        <ul className="remote-consent-points">
          <li>They will see everything on this screen{pending.mode === "control" ? ", and can use the mouse and keyboard" : ""}.</li>
          <li>A red frame shows while they are connected. You can press <strong>Stop</strong> at any time.</li>
          <li>Only allow this if you contacted MasalaPOS support.</li>
        </ul>
        {!isAdmin && <label className="remote-consent-pin"><span>Admin PIN to allow</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} disabled={busy} autoFocus /></label>}
        {error && <p className="remote-consent-error" role="alert">{error}</p>}
        <div className="remote-consent-actions">
          <button type="button" className="secondary" onClick={() => void answer("deny")} disabled={busy}>Don't allow</button>
          {!pending.connectorUrl && pending.mode === "control" && <button type="button" className="secondary" onClick={() => void answer("view")} disabled={busy}>Allow view only</button>}
          <button type="submit" className="primary" disabled={busy}>{pending.connectorUrl ? "Download connector" : pending.mode === "control" ? "Allow view and control" : "Allow"}</button>
        </div>
        <p className="remote-consent-timer">Closes on its own in {seconds} s if no one answers.</p>
      </form>}
    </WorkspaceDialog>
  </>;
}

interface LogEntry { id: number; sessionId: string; at: number; event: "requested" | "allowed" | "refused" | "started" | "ended"; agentName: string | null; actorName: string | null; detail: string | null }
const EVENT_WORDS: Record<LogEntry["event"], string> = { requested: "Asked", allowed: "Allowed", refused: "Refused", started: "Started", ended: "Ended" };
const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Settings → Help & support. */
export function SupportSettings() {
  const [status, setStatus] = useSupportStatus(false);
  const [installationId, setInstallationId] = useState<string | null>(null);
  useEffect(() => { void apiFetch<{ installationId: string | null }>("/api/license").then((l) => setInstallationId(l.installationId)).catch(() => {}); }, []);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void apiFetch<{ entries: LogEntry[] }>("/api/support/remote-log").then((r) => setLog(r.entries)).catch(() => {}); }, [status?.active, status?.pending]);
  const toggle = async (enabled: boolean) => {
    setError("");
    try { await apiFetch("/api/support/remote-settings", { method: "PUT", body: JSON.stringify({ enabled }) }); if (status) setStatus({ ...status, remoteEnabled: enabled }); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't save."); }
  };
  return <div className="support-settings">
    <section className="panel">
      <h4>Chat with MasalaPOS support</h4>
      <p className="muted">Opens a chat with a MasalaPOS support person in your browser. Anyone signed in can use the <strong>Get support</strong> button in the menu.</p>
      <div className="support-row"><GetSupportButton className="primary" />
        {status && <span className={`support-online ${status.online ? "on" : ""}`}>{!status.available ? "Not connected to MasalaPOS online" : status.online ? "Connected to MasalaPOS support" : "Connecting to MasalaPOS support…"}</span>}</div>
      {installationId && <p className="muted small">If support asks, this counter's Installation ID is <code>{installationId}</code>.</p>}
    </section>
    <section className="panel">
      <h4>Remote access</h4>
      <p className="muted">MasalaPOS support can ask to see this PC's screen to help you. Each time, someone at this PC must allow it (an admin, or with an admin's PIN), and can stop it at any time. Support Connector can access administrator windows. Windows admin prompts require separate permission in the connector.</p>
      {status && !status.canShare && <p className="notice">Screen sharing works only in the MasalaPOS desktop app on the main PC.</p>}
      <label className="support-toggle"><input type="checkbox" checked={status?.remoteEnabled ?? true} disabled={!status} onChange={(e) => void toggle(e.target.checked)} />
        <span>Allow MasalaPOS support to ask for remote access</span></label>
      {error && <p className="error" role="alert">{error}</p>}
      <h5>Recent requests</h5>
      {log.length === 0 ? <p className="muted">No remote access requests yet.</p>
        : <table className="support-log"><thead><tr><th>When</th><th>What</th><th>Support</th><th>Details</th></tr></thead>
          <tbody>{log.map((e) => <tr key={e.id}><td>{when.format(e.at)}</td><td>{EVENT_WORDS[e.event]}{e.actorName ? ` by ${e.actorName}` : ""}</td><td>{e.agentName ?? "—"}</td><td>{e.detail ?? ""}</td></tr>)}</tbody></table>}
    </section>
  </div>;
}
