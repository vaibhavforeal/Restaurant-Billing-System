import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { AI_TIMEOUT_MS, aiRequestInit } from "../ask-chat";
import { timeoutSignal } from "../abort-signal";
import { DEFAULT_AI_MODEL, modelOptions, usageRows, type AiCheckView, type AiModelInfo, type AiSettingsView } from "../ai-settings";

const PRIVACY = "Some free AI providers may keep what is sent. MasalaPOS sends only sales figures and dish and staff first names, never customer details. In your OpenRouter account, turn off 'allow training'.";
const box = { display: "grid", gap: 10, marginTop: 20, border: "1px solid var(--line)", borderRadius: "var(--radius-panel, 6px)", padding: 14 } as const;
const field = { display: "grid", gap: 4, maxWidth: 420 } as const;
const errorText = (e: unknown, fallback: string) => e instanceof ApiError ? e.message : fallback;

/** Settings → Restaurant profile → AI assistant: provider, key (write-only), model, fallback, Test and usage. */
export function AiAssistantSettings() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [models, setModels] = useState<AiModelInfo[] | null>(null);
  const [form, setForm] = useState({ enabled: false, model: DEFAULT_AI_MODEL, fallback: true, key: "" });
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function show(next: AiSettingsView) {
    setView(next);
    setForm({ enabled: next.settings.enabled, model: next.settings.model, fallback: next.settings.fallback, key: "" });
  }
  useEffect(() => {
    apiFetch<AiSettingsView>("/api/ai/settings").then(show).catch((e) => setStatus({ ok: false, text: errorText(e, "Could not load the AI assistant settings.") }));
    apiFetch<{ models: AiModelInfo[] }>("/api/ai/models", { signal: timeoutSignal(AI_TIMEOUT_MS.other) }).then((r) => setModels(r.models)).catch(() => setModels([]));
  }, []);

  async function save(patch: Record<string, unknown>, done: string) {
    setBusy(true); setStatus(null);
    try {
      show(await apiFetch<AiSettingsView>("/api/ai/settings", { method: "PUT", body: JSON.stringify(patch) }));
      window.dispatchEvent(new Event("masalapos:ai-settings"));
      setStatus({ ok: true, text: done });
    } catch (e) { setStatus({ ok: false, text: errorText(e, "Could not save the AI assistant settings.") }); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setStatus(null);
    try {
      const check = await apiFetch<AiCheckView>("/api/ai/test", aiRequestInit("other"));
      const limit = check.freeRequestsLimit !== null ? ` · ${check.freeRequestsUsed ?? 0} of ${check.freeRequestsLimit} free requests used today` : "";
      setStatus({ ok: true, text: `Working · answered by ${check.model}${limit}` });
      show(await apiFetch<AiSettingsView>("/api/ai/settings"));
    } catch (e) { setStatus({ ok: false, text: errorText(e, "The test request failed.") }); }
    finally { setBusy(false); }
  }

  const options = modelOptions(models ?? [], form.model);
  return <fieldset className="ai-assistant-settings" style={box}>
    <legend style={{ fontWeight: 650, padding: "0 6px" }}>AI assistant</legend>
    <p className="muted" style={{ margin: 0, fontSize: 12 }}>Ask MasalaPOS about sales, write end-of-day summaries and draft menu descriptions. Needs internet; billing never depends on it.</p>
    {view && <>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={form.enabled} disabled={busy || !view.keySaved} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Use the AI assistant{!view.keySaved && <small className="muted"> (save a key first)</small>}
      </label>
      <label style={field}>Provider<select value="openrouter" disabled={busy} onChange={() => undefined}><option value="openrouter">OpenRouter</option></select></label>
      {view.keySaved ? <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span>Key saved · ending …{view.keyEnding}</span>
        <button type="button" disabled={busy} onClick={() => void save({ key: null, enabled: false }, "Key removed.")}>Remove key</button>
      </div> : null}
      <label style={field}>{view.keySaved ? "Replace OpenRouter key" : "OpenRouter key"}
        <input type="password" autoComplete="off" value={form.key} disabled={busy || !view.canSaveKey} placeholder="sk-or-v1-…" onChange={(e) => setForm({ ...form, key: e.target.value })} />
        {!view.canSaveKey && <small className="muted">This PC can't protect a saved key, so a key can't be saved here.</small>}
      </label>
      <label style={field}>Model
        <select value={form.model} disabled={busy || models === null} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <small className="muted">{models === null ? "Loading OpenRouter's free models…" : models.length ? "OpenRouter's free models that can look up figures." : "Couldn't load OpenRouter's model list (needs internet)."}</small>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={form.fallback} disabled={busy} onChange={(e) => setForm({ ...form, fallback: e.target.checked })} />
        If it fails, try another free model
      </label>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>{PRIVACY}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void save({
          enabled: form.enabled || (!view.keySaved && form.key.trim().length > 0), model: form.model, fallback: form.fallback, ...(form.key.trim() ? { key: form.key.trim() } : {}),
        }, "Saved ✓")}>Save AI settings</button>
        <button type="button" disabled={busy || !view.keySaved} onClick={() => void test()}>Test</button>
      </div>
      <table style={{ maxWidth: 420, fontSize: 12 }}><thead><tr><th style={{ textAlign: "left" }}>Usage</th><th>Requests</th><th>Tokens</th></tr></thead>
        <tbody>{usageRows(view.usage).map((row) => <tr key={row.feature}><td>{row.feature}</td><td style={{ textAlign: "right" }}>{row.requests}</td><td style={{ textAlign: "right" }}>{row.tokens.toLocaleString("en-IN")}</td></tr>)}</tbody></table>
    </>}
    {status && <div role={status.ok ? "status" : "alert"} style={{ color: status.ok ? "var(--success-text, green)" : "var(--danger-text, crimson)" }}>{status.text}</div>}
  </fieldset>;
}
