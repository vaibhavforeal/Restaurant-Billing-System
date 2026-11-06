import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { aiRequestInit } from "../ask-chat";
import { serviceStatusText, usageRows, type AiSettingsView } from "../ai-settings";

const PRIVACY = "Questions go to MasalaPOS's AI service with sales figures and dish and staff first names only — never customer details.";
const errorText = (e: unknown, fallback: string) => e instanceof ApiError ? e.message : fallback;

/** The restaurant's assistant switch, service status and usage. */
export function AiAssistantSettings() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<AiSettingsView>("/api/ai/settings").then(setView).catch((e) => setStatus({ ok: false, text: errorText(e, "Could not load the AI assistant settings.") }));
  }, []);

  async function setEnabled(enabled: boolean) {
    setBusy(true); setStatus(null);
    try {
      setView(await apiFetch<AiSettingsView>("/api/ai/settings", { method: "PUT", body: JSON.stringify({ enabled }) }));
      window.dispatchEvent(new Event("masalapos:ai-settings"));
      setStatus({ ok: true, text: enabled ? "AI assistant switched on for this restaurant's staff." : "AI assistant switched off here." });
    } catch (e) { setStatus({ ok: false, text: errorText(e, "Could not save the AI assistant settings.") }); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setStatus(null);
    try {
      setView(await apiFetch<AiSettingsView>("/api/ai/test", aiRequestInit("other")));
      window.dispatchEvent(new Event("masalapos:ai-settings"));
      setStatus({ ok: true, text: "Checked with MasalaPOS." });
    } catch (e) { setStatus({ ok: false, text: errorText(e, "Couldn't reach MasalaPOS. Check the internet connection.") }); }
    finally { setBusy(false); }
  }

  const on = !!view?.service?.enabled;
  return <fieldset className="ai-assistant-settings">
    <legend>AI assistant · MasalaPOS</legend>
    <p className="muted">Ask about sales, summarize the day, and draft menu descriptions. Requires internet.</p>
    {!view && !status && <p role="status">Loading assistant status…</p>}
    {view && <>
      <p className={`ai-service-status${on ? " available" : ""}`} role="status">{serviceStatusText(view)}</p>
      {view.connected && <>
        <div className="ai-assistant-controls"><label>
          <input type="checkbox" checked={view.localEnabled} disabled={busy} onChange={(e) => void setEnabled(e.target.checked)} />
          Use the AI assistant
        </label>
          <button type="button" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check"}</button>
        </div>
        <small className="ai-assistant-help">Controls whether AI buttons appear for this restaurant's staff.</small>
        <details className="ai-assistant-data"><summary>Data shared with AI</summary><p>{PRIVACY}</p></details>
        <table className="ai-assistant-usage"><thead><tr><th>Usage on this counter</th><th>Requests</th><th>Tokens</th></tr></thead>
          <tbody>{usageRows(view.usage).map((row) => <tr key={row.feature}><td>{row.feature}</td><td>{row.requests}</td><td>{row.tokens.toLocaleString("en-IN")}</td></tr>)}</tbody></table>
      </>}
    </>}
    {status && <div role={status.ok ? "status" : "alert"} className={`ai-assistant-feedback ${status.ok ? "success" : "error"}`}>{status.text}</div>}
  </fieldset>;
}
