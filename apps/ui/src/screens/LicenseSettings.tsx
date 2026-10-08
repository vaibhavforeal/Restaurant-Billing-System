import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActivationRequest, LicensedDevice, LicenseHistory, LicensePreview, LicenseStatus } from "@forkflow/domain";
import { featureSummary } from "../license-features";
import { apiFetch, type User } from "../api";
import { downloadText } from "../download";
import { useNavigationGuard } from "../navigation-guard";
import { SystemSettings } from "./SystemSettings";
import "../license-settings.css";

interface LicenseContextValue { status: LicenseStatus | null; error: string; refresh(): Promise<void> }
const LicenseContext = createContext<LicenseContextValue | null>(null);
export function useLicense() {
  const value = useContext(LicenseContext);
  if (!value) throw new Error("License state requires LicenseGate");
  return value;
}
function useLicenseStatus(): LicenseContextValue {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0), mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const value = await apiFetch<LicenseStatus>("/api/license");
      if (mounted.current && request === sequence.current) { setStatus(value); setError(""); }
    } catch (e) { if (mounted.current && request === sequence.current) setError(e instanceof Error ? e.message : "Could not check the license"); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { clearTimeout(pending); pending = setTimeout(() => { void refresh(); }, 80); };
    const timer = setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener("forkflow:license-changed", changed); window.addEventListener("focus", changed);
    return () => { mounted.current = false; sequence.current++; clearTimeout(pending); clearInterval(timer);
      window.removeEventListener("forkflow:license-changed", changed); window.removeEventListener("focus", changed); };
  }, [refresh]);
  return { status, error, refresh };
}
const planName = (plan: LicenseStatus["plan"]) => plan === "basic" ? "Basic" : plan === "pro" ? "Pro" : "Not activated";
const dateTime = (time: number | null, timezone?: string) => time === null ? "Not recorded" : new Date(time).toLocaleString("en-IN", { timeZone: timezone });

export function LicenseGate({ user, children }: { user: User; children: ReactNode }) {
  const state = useLicenseStatus(), { status, error } = state;
  if (!status) return <main className="workspace"><p role={error ? "alert" : "status"}>{error || "Checking your plan..."}</p>
    {error && <button onClick={() => { void state.refresh(); }}>Retry license check</button>}</main>;
  return <LicenseContext.Provider value={state}>
    {!status.canOperate ? <main className="workspace license-recovery" id="main-content">
      {user.role === "admin" ? <><LicenseSettings /><SystemSettings backupOnly /></> : <><p role="alert">{status.message}</p><p>Ask your administrator to activate this installation or register this device.</p>
        <button onClick={() => { void state.refresh(); }}>Check again</button>{error && <p role="alert">{error}</p>}</>}
    </main> : <>
      {error && <p className="panel" role="status">Plan status could not refresh: {error} <button onClick={() => { void state.refresh(); }}>Retry</button></p>}
      {status.state === "grace" && <p className="panel" role="status">{status.message} Renew by {dateTime(status.graceUntil, status.timezone)}.</p>}
      {children}
    </>}
  </LicenseContext.Provider>;
}

export function LicenseSettings() {
  const { status, error: statusError, refresh: refreshStatus } = useLicense();
  const [devices, setDevices] = useState<LicensedDevice[] | null>(null);
  const [history, setHistory] = useState<LicenseHistory | null>(null);
  const [license, setLicense] = useState("");
  const [preview, setPreview] = useState<LicensePreview | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ device: LicensedDevice; name: string } | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const lock = useRef(false), sequence = useRef(0), mounted = useRef(false);
  const dirty = !!license.trim() || !!name.trim() || (!!renaming && renaming.name !== renaming.device.name);
  useNavigationGuard(() => {
    if (lock.current) { window.alert("Wait for the license or device request to finish before leaving."); return false; }
    return !dirty || window.confirm("Discard the unsaved license or device changes?");
  });
  useEffect(() => {
    if (!busy && !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [busy, dirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  const reload = useCallback(async () => {
    const request = ++sequence.current; setLoading(true);
    try {
      const [deviceList, events] = await Promise.all([apiFetch<{ devices: LicensedDevice[] }>("/api/license/devices"), apiFetch<LicenseHistory>("/api/license/history")]);
      if (mounted.current && request === sequence.current) { setDevices(deviceList.devices); setHistory(events); setLoadError(""); }
    } catch (e) {
      if (mounted.current && request === sequence.current) { setDevices(null); setHistory(null); setLoadError(e instanceof Error ? e.message : "Could not load devices and history"); }
    } finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (status?.mode !== "commercial") return;
    void reload();
    const timer = setInterval(() => { if (!lock.current) void reload(); }, 30_000);
    return () => clearInterval(timer);
  }, [status?.mode, status?.revision, reload]);
  async function run(action: () => Promise<void>, update = true) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      await action();
      if (mounted.current && update) { await Promise.all([...(status?.mode === "commercial" ? [reload()] : []), refreshStatus()]); window.dispatchEvent(new Event("forkflow:license-changed")); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Request failed"); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function readFile(file: File | undefined) {
    if (!file) return;
    void run(async () => {
      setPreview(null);
      if (file.size > 16_384) throw new Error("License files must be 16 KB or smaller.");
      const text = (await file.text()).replace(/^\uFEFF/, "").trim();
      if (!text || !text.startsWith("ff1.")) throw new Error("Choose the signed license file supplied by your provider.");
      setLicense(text); setMessage(`Loaded ${file.name}. Preview it before applying.`);
    }, false);
  }
  const timezone = status?.timezone;
  const current = devices?.find((d) => d.current);
  const canRegister = status && ["active", "grace"].includes(status.state) && !current && devices !== null && devices.length < (status.maxDevices ?? 0);
  return <section className="panel license-settings" aria-label="Plan and devices">
    <div className="license-heading"><div><h2>Plan and devices</h2><p>Activation, renewal and access for this restaurant.</p></div>
      <button disabled={busy || loading} onClick={() => { void run(async () => {}, true); }}>Refresh plan</button></div>
    {(error || loadError || statusError) && <p role="alert" className="error-message">{error || loadError || statusError}</p>}
    {message && <p role="status" className="license-message">{message}</p>}
    {status?.mode === "development" && <p>{status.message}</p>}
    {status?.mode === "commercial" && <>
      <div className="license-summary">
        <div><span className="license-label">Current plan</span><strong>{planName(status.plan)}</strong><span className={`license-badge ${status.state}`}>{status.state.replaceAll("_", " ")}</span></div>
        <div><span className="license-label">Registered devices</span><strong>{status.registeredDevices} / {status.maxDevices ?? "-"}</strong><span>{status.deviceRegistered ? "This browser is registered" : current ? status.maxDevices !== null ? "This browser is over the limit" : "Registration saved" : "This browser needs registration"}</span></div>
        <div><span className="license-label">Renewal due</span><strong className="license-date">{status.expiresAt === null ? "Awaiting activation" : dateTime(status.expiresAt, timezone)}</strong><span>{status.revision ? `License revision ${status.revision}` : "Import a license to get started"}</span></div>
      </div>
      <p role={status.canOperate ? "status" : "alert"}>{status.message}</p>
      {status.plan && <p className="license-help">{featureSummary(status.features)}<br />Offline grace ends: {dateTime(status.graceUntil, timezone)}. Times use {timezone} on the restaurant server.</p>}
      <details className="license-identity"><summary>Activation details</summary>
        <p>Installation ID: <code>{status.installationId}</code></p>
        <p className="license-help">Download these details for your license provider when activating or renewing.</p>
        <button disabled={busy} onClick={() => { void run(async () => {
          const request = await apiFetch<ActivationRequest>("/api/license/activation-request");
          downloadText(JSON.stringify(request, null, 2) + "\n", `forkflow-activation-${request.installationId}.json`, "application/json;charset=utf-8");
          setMessage("Activation request downloaded.");
        }, false); }}>Download activation request</button>
      </details>
      <div className="license-section"><h3>Import or renew a license</h3>
        <p className="license-help">Choose a file or paste the signed license from your provider. Preview checks its signature and shows the changes before you apply it.</p>
        <label>License file<input aria-label="License file" type="file" accept=".txt,.lic,text/plain" disabled={busy} onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
          setPreview(null); setPreview(await apiFetch<LicensePreview>("/api/license/preview", { method: "POST", body: JSON.stringify({ license }) }));
        }, false); }}>
          <label>Signed license<textarea rows={3} maxLength={16_384} required value={license} disabled={busy} spellCheck={false} onChange={(e) => { setLicense(e.target.value); setPreview(null); setError(""); }} /></label>
          <div className="license-actions"><button disabled={busy || !license.trim()}>Preview license</button>
            {license && <button type="button" disabled={busy} onClick={() => { setLicense(""); setPreview(null); setError(""); }}>Clear license</button>}</div>
        </form>
        {preview && <section className="license-preview" aria-label="License preview">
          <h4>{preview.alreadyInstalled ? "This license is already installed" : "Verified license"}</h4>
          <p>{planName(preview.currentPlan)} to <strong>{planName(preview.plan)}</strong> / Revision {preview.revision} / {preview.maxDevices} devices</p>
          <p>{featureSummary(preview.features)}</p>
          <p>Renewal due: {dateTime(preview.expiresAt, timezone)}<br />Offline grace ends: {dateTime(preview.graceUntil, timezone)}</p>
          {preview.blockedDevices.length > 0 && <p className="license-warning" role="status">The following devices will be blocked by this limit: {preview.blockedDevices.map((d) => d.name).join(", ")}. Their registrations and restaurant data are retained.</p>}
          {!preview.alreadyInstalled && <button className="primary" disabled={busy} onClick={() => { void run(async () => {
            await apiFetch("/api/license", { method: "PUT", body: JSON.stringify({ license, previewKey: preview.previewKey }) });
            setLicense(""); setPreview(null); setMessage("License applied successfully.");
          }); }}>Apply license</button>}
        </section>}
      </div>
      <div className="license-section"><h3>Registered devices</h3>
        <p className="license-help">Each PC or phone browser uses a slot. Tabs in the same browser share one. Sign in as an admin on a new browser to register it.</p>
        {loading && <p role="status">Refreshing devices and history...</p>}
        {devices?.length === 0 && <p>No devices registered yet.</p>}
        <ul className="license-devices">{devices?.map((device) => <li key={device.id}>
          <div><strong>{device.name}</strong>{device.current && <span className="license-badge">This browser</span>}{status.maxDevices !== null && !device.allowed && <span className="license-badge expired">Over limit</span>}
            <small>Registered {dateTime(device.createdAt, timezone)}<br />Last active: {dateTime(device.lastSeenAt, timezone)}</small></div>
          <div className="license-actions"><button disabled={busy || loading} aria-label={`Rename ${device.name}`} onClick={() => { setRenaming({ device, name: device.name }); }}>Rename</button>
            <button disabled={busy || loading} aria-label={`Remove ${device.name}`} onClick={() => {
              if (!window.confirm(`Remove ${device.name}? ${device.current ? "You will be signed out of this browser." : "Staff on that device will be signed out."}`)) return;
              void run(async () => { await apiFetch(`/api/license/devices/${device.id}`, { method: "DELETE", body: JSON.stringify({ version: device.version }) }); setMessage("Device removed."); if (renaming?.device.id === device.id) setRenaming(null); });
            }}>Remove</button></div>
        </li>)}</ul>
        {renaming && <form className="license-device-form" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          await apiFetch(`/api/license/devices/${renaming.device.id}`, { method: "PATCH", body: JSON.stringify({ name: renaming.name, version: renaming.device.version }) });
          setRenaming(null); setMessage("Device renamed.");
        }); }}><label>New device name<input required maxLength={80} disabled={busy} value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} /></label>
          <button disabled={busy || !devices || !renaming.name.trim()}>Save device name</button><button type="button" disabled={busy} onClick={() => setRenaming(null)}>Cancel rename</button></form>}
        {!current && <form className="license-device-form" onSubmit={(e) => { e.preventDefault(); if (canRegister) void run(async () => {
          await apiFetch("/api/license/devices", { method: "POST", body: JSON.stringify({ name }) }); setName(""); setMessage("This browser is registered.");
        }); }}><label>Device name<input required maxLength={80} value={name} placeholder="Main counter" disabled={busy || !canRegister} onChange={(e) => setName(e.target.value)} /></label>
          <button className="primary" disabled={busy || loading || !name.trim() || !canRegister}>Register this device</button></form>}
        {!current && devices && status.maxDevices !== null && devices.length >= status.maxDevices && <p className="license-warning">Device limit reached. Remove an unused registration or import an upgraded license.</p>}
      </div>
      <details className="license-section"><summary>License and device history</summary>
        <p className="license-help">Successful changes recorded on this restaurant server. Earlier changes are not backfilled.</p>
        {history?.events.length === 0 && <p>No changes recorded yet.</p>}
        <ol className="license-history">{history?.events.map((event) => <li key={event.id}><strong>{event.summary}</strong><small>{dateTime(event.occurredAt, timezone)} / {event.actorName}</small></li>)}</ol>
        {history?.nextBefore !== null && history?.nextBefore !== undefined && <button disabled={busy || loading} onClick={() => { void run(async () => {
          const page = await apiFetch<LicenseHistory>(`/api/license/history?before=${history.nextBefore}`);
          setHistory((old) => old ? { events: [...old.events, ...page.events.filter((e) => !old.events.some((o) => o.id === e.id))], nextBefore: page.nextBefore } : page);
        }, false); }}>Load older changes</button>}
      </details>
    </>}
  </section>;
}
