import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { aiRequestInit } from "../ask-chat";
import { serviceStatusText, usageRows, type AiSettingsView } from "../ai-settings";

const PRIVACY = "Questions go to MasalaPOS's AI service with sales figures and dish and staff first names only — never customer details.";
const box = { display: "grid", gap: 10, marginTop: 20, border: "1px solid var(--line)", borderRadius: "var(--radius-panel, 6px)", padding: 14 } as const;
const errorText = (e: unknown, fallback: string) => e instanceof ApiError ? e.message : fallback;

/** Settings → Restaurant profile → AI assistant: where it stands with MasalaPOS, the restaurant's own switch, Check and usage. */
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
  return <fieldset className="ai-assistant-settings" style={box}>
    <legend style={{ fontWeight: 650, padding: "0 6px" }}>AI assistant · provided by MasalaPOS</legend>
    <p className="muted" style={{ margin: 0, fontSize: 12 }}>Ask MasalaPOS about sales, write end-of-day summaries and draft menu descriptions. Needs internet; billing never depends on it.</p>
    {view && <>
      <p className="ai-service-status" role="status" style={{ margin: 0, fontWeight: 600, color: on ? "var(--success-text, green)" : "var(--ink)" }}>{serviceStatusText(view)}</p>
      {view.connected && <>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={view.localEnabled} disabled={busy} onChange={(e) => void setEnabled(e.target.checked)} />
          Use the AI assistant
        </label>
        <small className="muted">Turn this off to hide the AI buttons here, even while MasalaPOS has it on for the restaurant.</small>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>{PRIVACY}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check"}</button>
        </div>
        <table style={{ maxWidth: 420, fontSize: 12 }}><thead><tr><th style={{ textAlign: "left" }}>Usage on this counter</th><th>Requests</th><th>Tokens</th></tr></thead>
          <tbody>{usageRows(view.usage).map((row) => <tr key={row.feature}><td>{row.feature}</td><td style={{ textAlign: "right" }}>{row.requests}</td><td style={{ textAlign: "right" }}>{row.tokens.toLocaleString("en-IN")}</td></tr>)}</tbody></table>
      </>}
    </>}
    {status && <div role={status.ok ? "status" : "alert"} style={{ color: status.ok ? "var(--success-text, green)" : "var(--danger-text, crimson)" }}>{status.text}</div>}
  </fieldset>;
}
