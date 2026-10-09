import { useCallback, useEffect, useRef, useState } from "react";
import type { ZomatoSettings } from "@forkflow/domain/zomato";
import { apiFetch } from "../api";
import { dateTime, errorMessage } from "../zomato-format";
import { WorkspaceDialog } from "../WorkspaceDialog";
import "../zomato.css";

export function ZomatoConnection({ settings, canEdit, onSaved }: { settings: ZomatoSettings; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(settings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => { if (!dirty) setForm(settings); }, [settings, dirty]);
  function update(key: "restaurantId" | "restaurantName" | "posId" | "webhookBaseUrl", value: string) { setForm(old => ({ ...old, [key]: value })); setDirty(true); setMessage(""); }
  async function save() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const saved = await apiFetch<ZomatoSettings>("/api/zomato/settings", { method: "PATCH", body: JSON.stringify(form) });
      setForm(saved); setDirty(false); setMessage(saved.enabled ? "Connection saved. Verified live receiving is enabled." : "Connection details saved. Live activation still requires the approved integration."); await onSaved();
    } catch (e) { setError(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="zomato-connection"><form className="panel" onSubmit={e => { e.preventDefault(); void save(); }}>
    <h3>Restaurant connection</h3><p className="muted">Use the restaurant ID from your Zomato account. This ledger supports one restaurant.</p>
    {!canEdit && <p>Only an administrator can change the connection.</p>}
    <fieldset disabled={!canEdit || busy} className="zomato-fields"><label>Zomato restaurant ID<input required maxLength={160} value={form.restaurantId} onChange={e => update("restaurantId", e.target.value)} /></label>
      <label>Restaurant name<input maxLength={160} value={form.restaurantName} onChange={e => update("restaurantName", e.target.value)} /></label>
      <label>POS vendor ID <small>(when assigned by Zomato)</small><input maxLength={160} value={form.posId} onChange={e => update("posId", e.target.value)} /></label>
      <label>Public webhook service origin <small>(when available)</small><input type="url" placeholder="https://orders.your-domain.com" maxLength={500} value={form.webhookBaseUrl} onChange={e => update("webhookBaseUrl", e.target.value)} /></label>
      {settings.adapterConfigured && <label className="zomato-check"><input type="checkbox" checked={form.enabled} onChange={e => { setForm(old => ({ ...old, enabled: e.target.checked })); setDirty(true); }} /> Enable verified live receiving</label>}
    </fieldset>
    {dirty && form.version !== settings.version && <p role="alert">Another counter changed these settings. <button type="button" onClick={() => { setForm(settings); setDirty(false); }}>Reload saved values</button></p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {canEdit && <button type="submit" className="primary" disabled={busy || !dirty || form.version !== settings.version}>{busy ? "Saving…" : "Save connection"}</button>}
  </form><aside className="panel"><h3>Activate live orders later</h3><ol>
    <li>Apply for Zomato POS vendor onboarding and obtain approved organization access.</li>
    <li>Obtain the POS ID, API keys and authenticated webhook configuration from your Zomato contact.</li>
    <li>Connect an always-available HTTPS service to this local restaurant, including durable delivery while the PC is offline.</li>
    <li>Implement and certify the official payloads, authentication and order actions before switching on live orders.</li>
  </ol><p>Saving an address does not deploy a webhook service or register it with Zomato. Keep managing live orders in the Zomato partner app.</p>
    <p><a href="https://www.zomato.com/developer/integration/docs/overview" target="_blank" rel="noreferrer">Official integration guide</a></p>
    <p><a href="https://www.zomato.com/developer/integration/docs/getting-started/development-for-integration/pre-integration" target="_blank" rel="noreferrer">Zomato onboarding requirements</a></p>
    <small>Last verified incoming event: {dateTime(settings.lastEventAt)}</small>
  </aside></div>;
}

/** The Marketplace's Zomato Settings: loads the saved connection while open and shows the connection form in a dialog. */
export function ZomatoSettingsDialog({ open, canEdit, onClose }: { open: boolean; canEdit: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<ZomatoSettings | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setSettings(await apiFetch<ZomatoSettings>("/api/zomato/settings", { cache: "no-store" })); setError(""); }
    catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);
  return <WorkspaceDialog open={open} title="Zomato settings" onClose={onClose} className="zomato-connection-dialog">
    {open && <div className="zomato-screen">
      {error && <p role="alert">{error}. <button type="button" onClick={() => void load()}>Try again</button></p>}
      {!settings && !error && <p role="status">Loading Zomato settings…</p>}
      {settings && <ZomatoConnection settings={settings} canEdit={canEdit} onSaved={load} />}
    </div>}
  </WorkspaceDialog>;
}
