import { useEffect, useState } from "react";
import { DEFAULT_SHORTCUTS, decodeShortcuts, SHORTCUT_ACTIONS, SHORTCUT_KEYS, shortcutErrors, type ShortcutAction } from "../shortcut-bindings";
import { saveShortcutBindings, shortcutSnapshot, useShortcutBindings } from "../pos-shortcuts";
import { useNavigationGuard } from "../navigation-guard";
import "../keyboard-settings.css";

export function KeyboardSettings() {
  const current = useShortcutBindings();
  const [baseline, setBaseline] = useState(shortcutSnapshot);
  const [draft, setDraft] = useState(() => ({ ...current }));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dirty = SHORTCUT_ACTIONS.some(action => draft[action.id] !== decodeShortcuts(baseline).bindings[action.id]);
  const errors = shortcutErrors(draft);
  const changedElsewhere = baseline !== shortcutSnapshot();
  useNavigationGuard(() => !dirty || window.confirm("Discard unsaved keyboard shortcut changes?"));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) { setDraft({ ...current }); setBaseline(shortcutSnapshot()); }
  }, [current, dirty]);
  function change(action: ShortcutAction, key: string) {
    setDraft(previous => ({ ...previous, [action]: key })); setMessage(""); setError("");
  }
  return <section className="panel keyboard-settings" data-shortcut-ignore aria-label="Keyboard shortcuts">
    <h3>Keyboard shortcuts</h3>
    <p>Choose keys for this device. Changes apply to staff using this browser profile; other counters keep their own settings.</p>
    <p className="muted">Shortcuts use the available on-screen actions and keep their permissions. While a dialog is open, only its actions run. Function keys reserved for help, refresh and browser tools are excluded.</p>
    {decodeShortcuts(baseline).invalid && <p role="alert">Saved shortcuts could not be read. Default keys are shown; save to replace the invalid settings.</p>}
    {changedElsewhere && dirty && <p role="alert">Shortcuts changed in another window. Discard changes to load the latest settings.</p>}
    <form onSubmit={event => {
      event.preventDefault(); setError(""); setMessage("");
      try { saveShortcutBindings(draft, baseline); setBaseline(shortcutSnapshot()); setMessage("Keyboard shortcuts saved for this device."); }
      catch (error) { setError(error instanceof Error ? error.message : "Could not save shortcuts."); }
    }}>
      <div className="keyboard-rows">{SHORTCUT_ACTIONS.map(action => <div className="keyboard-row" key={action.id}>
        <div><label htmlFor={`shortcut-${action.id}`}>{action.label}</label><p id={`shortcut-help-${action.id}`}>{action.description}</p></div>
        <div><select id={`shortcut-${action.id}`} aria-label={`${action.label} shortcut`} aria-describedby={`shortcut-help-${action.id}${errors[action.id] ? ` shortcut-error-${action.id}` : ""}`} aria-invalid={!!errors[action.id]} value={draft[action.id]} onChange={event => change(action.id, event.target.value)}>
          <option value="">Disabled</option>{SHORTCUT_KEYS.map(key => <option key={key} value={key}>{key}</option>)}
        </select>{errors[action.id] && <p id={`shortcut-error-${action.id}`} className="keyboard-error">{errors[action.id]}</p>}</div>
      </div>)}</div>
      <div className="keyboard-actions">
        <button className="primary" type="submit" disabled={Object.keys(errors).length > 0 || (changedElsewhere && dirty)}>Save shortcuts</button>
        <button type="button" onClick={() => { setDraft({ ...DEFAULT_SHORTCUTS }); setMessage("Default keys selected. Save shortcuts to apply."); setError(""); }}>Reset to defaults</button>
        {dirty && <button type="button" onClick={() => { const raw = shortcutSnapshot(); setBaseline(raw); setDraft(decodeShortcuts(raw).bindings); setMessage(""); setError(""); }}>Discard changes</button>}
      </div>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    </form>
  </section>;
}
