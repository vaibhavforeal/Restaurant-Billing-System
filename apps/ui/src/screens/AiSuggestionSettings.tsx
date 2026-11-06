import { InfoTip } from "../InfoTip";
import { SaveStatus, useSettingsForm } from "../use-settings-form";
import { AiAssistantSettings } from "./AiAssistantSettings";
import "../ai-suggestion-settings.css";

/** Settings → AI suggestions: the smart menu hints and the AI assistant. */
export function AiSuggestionSettings() {
  const { form, update, save, busy, status, message } = useSettingsForm("Could not save the AI suggestion settings");
  if (!form) return <div className="panel">{status === "error" ? <p role="alert">{message}</p> : <p role="status">Loading settings…</p>}</div>;
  return <div className="panel ai-suggestion-settings">
    <section className="ai-menu-settings" aria-label="Menu suggestions">
      <h3>Menu suggestions</h3>
      <div className="ai-menu-options">
      <div className="ai-popular-settings">
      <label className="ai-setting-row">
        <input type="checkbox" checked={form.popularItemsEnabled} disabled={busy} aria-describedby="popular-items-help"
          onChange={(e) => update({ popularItemsEnabled: e.target.checked })} />
        <span>Show popular items <InfoTip id="popular-items-help">Marks the dish that sold most in each category over the last 30 days as Popular and shows it first, on staff order screens and the QR table menu.</InfoTip><small>Show category best-sellers first.</small></span>
      </label>
      <label className="ai-setting-row ai-setting-dependent">
        <input type="checkbox" checked={form.popularByTimeEnabled} disabled={busy || !form.popularItemsEnabled} aria-describedby="popular-by-time-help"
          onChange={(e) => update({ popularByTimeEnabled: e.target.checked })} />
        <span>Match the time of day <InfoTip id="popular-by-time-help">Popular follows the clock: each category's best-seller from 2 hours either side of now over the last 30 days, or its all-day best-seller when there were too few sales at this hour.</InfoTip></span>
      </label>
      </div>
      <label className="ai-setting-row">
        <input type="checkbox" checked={form.orderedTogetherEnabled} disabled={busy} aria-describedby="ordered-together-help"
          onChange={(e) => update({ orderedTogetherEnabled: e.target.checked })} />
        <span>Suggest dishes ordered together <InfoTip id="ordered-together-help">Shows up to 3 dishes from other categories that often share a bill with what is already in the cart, over the last 30 days, on staff order screens and the QR table menu.</InfoTip><small>Recommend dishes that go with the current cart.</small></span>
      </label>
      <label className="ai-setting-row">
        <input type="checkbox" checked={form.customerUsualEnabled} disabled={busy} aria-describedby="customer-usual-help"
          onChange={(e) => update({ customerUsualEnabled: e.target.checked })} />
        <span>Suggest a customer's usual <InfoTip id="customer-usual-help">When a saved customer is added to an order, shows the dishes on at least 2 of their bills in the last 6 months, and a button to repeat their last order. Needs CRM &amp; Loyalty.</InfoTip><small>Use a saved customer's past orders. Requires CRM &amp; Loyalty.</small></span>
      </label>
      </div>
      <div className="ai-suggestion-actions">
        <button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <SaveStatus status={status} message={message} />
      </div>
    </section>
    <AiAssistantSettings />
  </div>;
}
